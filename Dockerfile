FROM node:18

WORKDIR /app

RUN apt-get update && apt-get install -y git

RUN rm -rf /app/.git
RUN git clone https://github.com/HappyYuzu/akash-r1.git /app

RUN npm install --omit=dev

ENV PORT=7860

EXPOSE 7860

CMD ["node", "app.js"]
