import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import * as bodyParser from 'body-parser';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from '@nestjs/common';

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  // Crear app sin bodyParser por defecto
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false, // Desactivar el parser de cuerpo integrado
  });

  // Usar un enfoque más simple para el manejo de webhooks
  // Primero para la ruta específica del webhook
  app.use('/stripe/webhook', bodyParser.raw({ type: 'application/json' }));

  // Después para todas las demás rutas
  app.use(bodyParser.json({ limit: '10mb' }));
  app.use(bodyParser.urlencoded({ extended: true }));

  // Habilitar CORS
  app.enableCors({
    origin: [
      'http://localhost:5174',
      'http://localhost:5173',
      'https://estate-admin.com',
    ], // Orígenes permitidos
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
  });

  const port = process.env.PORT || 3000;
  await app.listen(port);
  logger.log(`Aplicación ejecutándose en: ${await app.getUrl()}`);
}
bootstrap();
