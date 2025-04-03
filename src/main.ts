import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import * as bodyParser from 'body-parser';
import { NestExpressApplication } from '@nestjs/platform-express';

async function bootstrap() {
  // Usar explícitamente la plataforma Express para tener acceso a sus métodos específicos
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // Configurar JSON parser para todas las rutas primero
  app.use(bodyParser.json());

  // Sobreescribir SOLO para la ruta del webhook con raw parser
  app.use('/stripe/webhook', bodyParser.raw({ type: 'application/json' }));

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
}
bootstrap();
