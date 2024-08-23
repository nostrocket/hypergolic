# Use the official Node.js 18 image as the base image
FROM node:18

# Set the working directory inside the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json to leverage Docker's cache
COPY package*.json ./

# Install the project dependencies inside the container
RUN npm install

# Copy the rest of the application code to the working directory
COPY . .

# Expose the port your application will run on (optional)
EXPOSE 5173

# Start the container with 'npm run dev'
CMD ["npm", "run", "dev"]