# Simple, reliable Dockerfile
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package.json
COPY package.json ./

# Install dependencies (works without lockfile)
RUN npm install --only=production

# Copy the rest of the application
COPY . .

# Expose port
EXPOSE 8000

# Set environment to production
ENV NODE_ENV=production

# Start the application
CMD ["npm", "start"]
