FROM node:20-alpine
WORKDIR /app
COPY package.json .
RUN npm install --production
COPY *.js .
# No EXPOSE: this service has no HTTP route, it only consumes RabbitMQ events.
CMD ["node", "index.js"]
