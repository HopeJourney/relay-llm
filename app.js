require("dotenv").config();
const fs = require("fs");
const express = require("express");
const axios = require("axios");
const app = express();
const cors = require("cors");

const envFile = fs.readFileSync('./.env.json', 'utf8');
const envData = JSON.parse(envFile);
app.use(cors(
    {
        origin: "*",
        credentials: true,
    }
));
app.use(express.json({ limit: "10mb" }));
app.enable("trust proxy");

function isExistsKey (key) {
    return Object.keys(envData.keys).includes(key)
}

function normalizeMessages(messages) {
    if (!messages || messages.length === 0) return [];
    const systemMessages = messages.filter((msg) => msg.role === "system");
    const nonSystemMessages = messages.filter((msg) => msg.role !== "system");
    let normalizedMessages = [];

    if (systemMessages.length > 0) {
        normalizedMessages.push({
            role: "system",
            content: systemMessages.map((msg) => msg.content).join("\n"),
        });
    }

    let currentRole = null;
    let currentContent = [];

    for (const message of nonSystemMessages) {
        if (currentRole === null) {
            currentRole = message.role;
            currentContent.push(message.content);
        } else if (currentRole === message.role) {
            currentContent.push(message.content);
        } else {
            if (currentContent.length > 0) {
                normalizedMessages.push({
                    role: currentRole,
                    content: currentContent.join("\n"),
                });
            }
            currentRole = message.role;
            currentContent = [message.content];
        }
    }

    if (currentRole && currentContent.length > 0) {
        normalizedMessages.push({
            role: currentRole,
            content: currentContent.join("\n"),
        });
    }

    if (normalizedMessages[normalizedMessages.length - 1]?.role === "assistant") {
        normalizedMessages.pop();
    }

    if (normalizedMessages[0]?.role === "system" && (!normalizedMessages[1] || normalizedMessages[1].role !== "user")) {
        normalizedMessages.splice(1, 0, { role: "user", content: "" });
    }

    if (normalizedMessages[normalizedMessages.length - 1]?.role !== "user") {
        normalizedMessages.push({ role: "user", content: "" });
    }

    return normalizedMessages;
}

app.get("/", (req, res) => {
    const protocol = req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
    const host = req.get("host");
    const spaceUrl = `${protocol}://${host}/v1/chat/completions`;
    res.json({ spaceUrl });
});

app.post("/v1/chat/completions", async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || 
            authHeader.includes(`Bearer `) === false || 
            isExistsKey(authHeader.split(" ")[1]) === false) {
            return res.status(403).json({ error: "Forbidden: Invalid key" });
        }

        const apiUrl = envData.apiUrl;
        const messages = normalizeMessages(req.body.messages || []);
        const temperature = req.body.temperature !== undefined ? req.body.temperature : 1;
        const requestData = {
            model: req.body.model,
            messages: messages,
            ...(req.body.model == "claude-3.7-sonnet-thought" ? 
                { max_output_tokens: req.body.max_tokens || 4096 } :
                { max_tokens: req.body.max_tokens || 4096 }),
            temperature: temperature,
            stream: req.body.stream || false,
        };

        console.log("Outgoing request to API:");
        console.log(JSON.stringify(requestData, null, 2));

        const response = await axios({
            method: "post",
            url: apiUrl,
            data: requestData,
            responseType: "stream",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${envData.keys[authHeader.split(" ")[1]]}`,
            },
        });

        if (!req.body.stream) {
            const combinedContent = response?.data?.choices?.[0]?.message?.content
            const response = {
                id: `${Math.random().toString(36).substring(7)}`,
                object: "chat.completion",
                created: Date.now(),
                model: requestData.model,
                choices: [
                    {
                        message: {
                            role: "assistant",
                            content: combinedContent,
                        },
                        finish_reason: "stop",
                        index: 0,
                    },
                ],
            };
            return res.json(response);
        }

        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");

        const keepAliveInterval = setInterval(() => {
            if (!res.writableEnded) {
                res.write(": keep-alive\n\n");
            }
        }, 10000);

        let buffer = "";
        
        // 응답 스트림의 인코딩을 utf8로 설정
        response.data.setEncoding("utf8");

        const waitingData = setInterval(() => {
            res.write(`data: ${JSON.stringify(
                {
                    "choices": [{
                        "index": 0,
                        "delta": {"content":"ㅤ","role":"assistant"}
                    }],
                    "created": Date.now(),
                    "model": req.body.model,
                })
            }\n\n`)
        }, 30000)

        response.data.on("data", (chunk) => {
            clearInterval(waitingData)

            const chunkStr = chunk.toString();
            buffer += chunkStr;
            
            // 완전한 이벤트로 구성된 부분만 처리
            const lines = buffer.split("\n\n");
            buffer = lines.pop() || ""; // 마지막 항목은 완전하지 않을 수 있으므로 버퍼에 유지
            
            for (const line of lines) {
                if (!line.trim()) continue;
                if (line === "data: [DONE]") {
                    res.write(line + "\n\n");
                    continue;
                }
                if (line.startsWith("data: ")) {
                    console.log(line)
                    try {
                        const jsonData = JSON.parse(line.slice(6));
                        res.write(`data: ${JSON.stringify(jsonData)}\n\n`);
                    } catch (error) {
                        console.error("JSON Parse Error:", error.message);
                    }
                }
            }
        });

        response.data.on("end", () => {
            clearInterval(keepAliveInterval);
            res.end();
        });

        response.data.on("error", (error) => {
            clearInterval(keepAliveInterval);
            console.error("Stream error:", error);
            res.end();
        });
    } catch (error) {
        console.error("API Request Error:", error.message);
        res.status(500).json({ error: { message: "An error occurred while processing your request.", details: error.message } });
    }
});

const PORT = process.env.PORT || 7860;
app.listen(PORT, () => console.log(`Proxy server running on port ${PORT}`));
