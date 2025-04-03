import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import * as bodyParser from 'body-parser';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from '@nestjs/common';

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  // Usar explícitamente la plataforma Express para tener acceso a sus métodos específicos
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Orden específico: primero configurar la ruta de webhook con raw
  app.use('/stripe/webhook', (req, res, next) => {
    if (req.method === 'POST') {
      logger.log('Recibido webhook en /stripe/webhook, usando raw parser');
      bodyParser.raw({ type: 'application/json' })(req, res, next);
    } else {
      next();
    }
  });

  // Luego configurar el resto de rutas con JSON parser
  app.use((req, res, next) => {
    if (req.originalUrl !== '/stripe/webhook' || req.method !== 'POST') {
      bodyParser.json()(req, res, next);
    } else {
      next();
    }
  });

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
