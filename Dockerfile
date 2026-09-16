# ==========================================
# Fase 1: Construcción (Builder)
# ==========================================
FROM node:20-alpine AS builder

WORKDIR /app

# Copiar ficheros de dependencias
COPY package.json package-lock.json* ./

# Instalar dependencias
RUN npm ci

# Copiar el resto del código fuente del proyecto
COPY . .

# Construir la aplicación para producción (genera la carpeta dist o .next)
RUN npm run build

# ==========================================
# Fase 2: Producción (Runtime ligero)
# ==========================================
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# Crear usuario sin privilegios por seguridad
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Copiar los artefactos necesarios desde el builder
# (Ajusta según uses Astro con adaptador de Node o Next.js)
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json

COPY --from=builder --chown=nextjs:nodejs /app/dist ./dist
COPY --from=builder --chown=nextjs:nodejs /app/node_modules ./node_modules

USER nextjs

# Puerto en el que correrá la app dentro del contenedor
EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# Comando de inicio para producción
CMD ["node", "./dist/server/entry.mjs"]
