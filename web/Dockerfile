# Rewind web UI: built with Vite, served by nginx. nginx also does what the
# Vite dev proxy does in development: /api goes to the server and /intel to
# the intel service, so the browser still talks to one origin.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
# The nginx image fills ${REWIND_SERVER_URL} and ${INTEL_URL} in templates
# from the environment when the container starts.
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
