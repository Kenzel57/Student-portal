FROM node:20-alpine
# WeasyPrint (HTML -> PDF) and its system libraries come from Alpine's own
# package repository; DejaVu fonts cover accented characters in names.
RUN apk add --no-cache weasyprint font-dejavu
WORKDIR /app
COPY package.json .
RUN npm install --production
COPY *.js .
EXPOSE 3000
CMD ["node", "index.js"]
