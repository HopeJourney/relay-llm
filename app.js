require("dotenv").config();
const express = require("express");
const axios = require("axios");
const app = express();

app.use(express.json({ limit: "10mb" }));
app.enable("trust proxy");

app.use((req, res, next) => {
    if (req.headers["x-forwarded-proto"] !== "https") {
        return res.redirect(`https://${req.headers.host}${req.url}`);
    }
    next();
});

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
        if (!authHeader || authHeader !== `Bearer ${process.env.PASSWORD}`) {
            return res.status(403).json({ error: "Forbidden: Invalid password" });
        }

        const apiUrl = "https://chatapi.akash.network/api/v1/chat/completions";
        const messages = normalizeMessages(req.body.messages || []);
        const temperature = req.body.temperature !== undefined ? req.body.temperature : 1;
        const requestData = {
            model: "DeepSeek-R1",
            messages: messages,
            max_tokens: req.body.max_tokens || 4096,
            temperature: temperature,
            stream: true,
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
                Authorization: `Bearer ${process.env.TOKEN}`,
            },
        });

        if (!req.body.stream) {
            let combinedContent = "";
            for await (const chunk of response.data) {
                const chunkStr = chunk.toString();
                const lines = chunkStr.split("\n");
                for (const line of lines) {
                    if (!line.trim()) continue;
                    if (line.startsWith("data: ")) {
                        try {
                            const jsonData = JSON.parse(line.slice(6));
                            const content = jsonData.choices?.[0]?.delta?.content || "";
                            combinedContent += content.replace(/<think>/g, "<Thoughts>").replace(/<\/think>/g, "</Thoughts>");
                        } catch (error) {
                            console.error("JSON Parse Error:", error.message);
                        }
                    }
                }
            }

            const R1response = {
                id: `deepseek-${Math.random().toString(36).substring(7)}`,
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
            return res.json(R1response);
        }

        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");

        const keepAliveInterval = setInterval(() => {
            if (!res.writableEnded) {
                res.write(": keep-alive\n\n");
            }
        }, 10000);

        response.data.on("data", (chunk) => {
            const chunkStr = chunk.toString();
            const lines = chunkStr.split("\n");
            for (const line of lines) {
                if (!line.trim()) continue;
                if (line === "data: [DONE]") {
                    res.write(line + "\n\n");
                    return;
                }
                if (line.startsWith("data: ")) {
                    try {
                        const jsonData = JSON.parse(line.slice(6));
                        if (jsonData.choices && jsonData.choices[0]?.delta?.content) {
                            jsonData.choices[0].delta.content = jsonData.choices[0].delta.content
                                .replace(/<think>/g, "<Thoughts>")
                                .replace(/<\/think>/g, "</Thoughts>");
                        }
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
