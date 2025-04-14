# Utiliza una imagen ligera de Node.js 18
FROM node:18-alpine

# Establece el directorio de trabajo
WORKDIR /app

# Copia los archivos de definición de dependencias
COPY package*.json ./

# Instala las dependencias (para producción)
RUN npm install --production

# Copia el resto del código fuente
COPY . .

# Ejecuta la compilación de la aplicación (asegúrate de tener el script "build")
RUN npm run build

# Expone el puerto (ajusta si tu app escucha en otro puerto)
EXPOSE 3000

# Comando para iniciar la aplicación (usa el script "start" definido en package.json)
CMD ["npm", "run", "start"]
