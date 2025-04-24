# Etapa de construcción
FROM node:18-alpine AS build

# Establece el directorio de trabajo
WORKDIR /app

# Copia los archivos de definición de dependencias
COPY package*.json ./

# Instala todas las dependencias (incluyendo devDependencies para compilar)
RUN npm install

# Copia el resto del código fuente
COPY . .

# Ejecuta la compilación de la aplicación
RUN npm run build

# Etapa de producción
FROM node:18-alpine

# Establece el directorio de trabajo
WORKDIR /app

# Copia los archivos de package.json
COPY package*.json ./

# Instala solo las dependencias de producción
RUN npm install --omit=dev

# Copia el código compilado desde la etapa de build
COPY --from=build /app/dist ./dist

# Expone el puerto que usa Cloud Run (8080)
EXPOSE 8080

# Variable de entorno para indicar que estamos en producción
ENV NODE_ENV=production

# Comando para iniciar la aplicación
CMD ["node", "dist/main.js"]
