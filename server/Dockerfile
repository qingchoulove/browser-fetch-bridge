FROM node:22-alpine

ENV NODE_ENV=production
ENV BROWSER_BRIDGE_HOST=0.0.0.0
ENV BROWSER_BRIDGE_PORT=37891

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server

EXPOSE 37891

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "const http=require('node:http');const port=Number(process.env.BROWSER_BRIDGE_PORT||37891);const token=process.env.BROWSER_BRIDGE_TOKEN||'browser-fetch-bridge-dev';const req=http.get({host:'127.0.0.1',port,path:'/status',headers:{'x-browser-bridge-token':token}},res=>{res.resume();process.exit(res.statusCode===200?0:1);});req.on('error',()=>process.exit(1));req.setTimeout(4000,()=>req.destroy());"

USER node

CMD ["node", "server/service.js"]
