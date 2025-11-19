import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import * as bodyParser from 'body-parser';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Logger } from '@nestjs/common';
import * as crypto from 'crypto';

// Polyfill para crypto en el contexto global (necesario para @nestjs/schedule)
if (typeof global.crypto === 'undefined') {
  (global as any).crypto = crypto;
}

async function bootstrap() {
  const logger = new Logger('Bootstrap');

  try {
    logger.log('🚀 Starting application...');
    logger.log(`📦 Node Environment: ${process.env.NODE_ENV || 'development'}`);
    logger.log(`🔌 Target Port: ${process.env.PORT || 8080}`);

    // Crear app sin bodyParser por defecto
    logger.log('📝 Creating NestJS application...');
    const app = await NestFactory.create<NestExpressApplication>(AppModule, {
      bodyParser: false, // Desactivar el parser de cuerpo integrado
    });
    logger.log('✅ NestJS application created');

    // Usar un enfoque más simple para el manejo de webhooks
    // Primero para la ruta específica del webhook
    logger.log('⚙️ Configuring body parsers...');
    app.use('/stripe/webhook', bodyParser.raw({ type: 'application/json' }));

    // Después para todas las demás rutas
    app.use(bodyParser.json({ limit: '10mb' }));
    app.use(bodyParser.urlencoded({ extended: true }));
    logger.log('✅ Body parsers configured');

    // Habilitar CORS
    logger.log('🌐 Enabling CORS...');
    app.enableCors({
      origin: [
        'http://localhost:5174',
        'http://localhost:5173',
        'https://estate-admin.com',
      ], // Orígenes permitidos
      methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
      credentials: true,
    });
    logger.log('✅ CORS enabled');

    // Obtener el puerto de la variable de entorno o usar 8080 como predeterminado para Cloud Run
    const port = process.env.PORT || 8080;

    // Escuchar en todas las interfaces de red (0.0.0.0) es importante para contenedores
    logger.log(`🎧 Starting to listen on port ${port}...`);
    await app.listen(port, '0.0.0.0');

    logger.log(`✅ Aplicación ejecutándose en puerto: ${port}`);
    logger.log(`🌍 URL completa: ${await app.getUrl()}`);
    logger.log('🎉 Application started successfully!');
  } catch (error) {
    logger.error('❌ CRITICAL ERROR during bootstrap:', error.message);
    logger.error('Stack trace:', error.stack);
    // Salir con código de error para que Cloud Run lo detecte
    process.exit(1);
  }
}

bootstrap().catch((error) => {
  console.error('❌ Unhandled error in bootstrap:', error);
  process.exit(1);
});
