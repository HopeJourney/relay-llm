# Use Node.js LTS as the base image
FROM node:18-bullseye-slim

# Update and install git
RUN apt-get update && apt-get install -y git

# Set the working directory inside the container
WORKDIR /usr/src/app

# Clone the repository
RUN git clone https://github.com/HappyYuzu/akash-r1.git .

# Install dependencies
RUN npm install

# Expose the port the app runs on
EXPOSE 7860

# Set environment variables
ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=12882"

# Start the application
CMD ["node", "app.js"]
