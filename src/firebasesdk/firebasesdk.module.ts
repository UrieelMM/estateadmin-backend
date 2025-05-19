import * as admin from 'firebase-admin';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { FirebaseAuthService } from './firebasesdk-service';
import { RegisterCondominiumUsersCase } from '../cases/users-condominiums-auth/register-condominiums.case';
import * as dotenv from 'dotenv';
import { ToolsModule } from '../tools/tools.module';
import { StripeModule } from '../stripe/stripe.module';
import { WhatsappChatBotModule } from '../whatsapp-chat-bot/whatsapp-chat-bot.module';
import { GeminiModule } from '../gemini/gemini.module';
import { CondominiumUsersModule } from '../condominium-users/condominium-users.module';

dotenv.config();
/**
 * The `FirebasesdkModule` is responsible for initializing the Firebase Admin SDK
 * using environment variables for configuration. It imports various modules like
 * ConfigModule, ToolsModule, StripeModule, WhatsappChatBotModule, and GeminiModule
 * to integrate their functionalities. It provides and exports the FirebaseAuthService
 * to be used across the application, and sets Firestore settings to ignore undefined
 * properties in documents.
 */
@Module({
  imports: [
    ConfigModule,
    ToolsModule,
    StripeModule,
    WhatsappChatBotModule,
    GeminiModule,
    CondominiumUsersModule,
  ],
  providers: [FirebaseAuthService, RegisterCondominiumUsersCase],
  exports: [FirebaseAuthService],
})
export class FirebasesdkModule {
  constructor() {
    const firebaseParams = {
      type: process.env.FIREBASE_TYPE,
      project_id: process.env.FIREBASE_PROJECT_ID,
      private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
      private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      client_email: process.env.FIREBASE_CLIENT_EMAIL,
      client_id: process.env.FIREBASE_CLIENT_ID,
      auth_uri: process.env.FIREBASE_AUTH_URI,
      token_uri: process.env.FIREBASE_TOKEN_URI,
      auth_provider_x509_cert_url:
        process.env.FIREBASE_AUTH_PROVIDER_X509_CERT_URL,
      client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL,
      universe_domain: process.env.FIREBASE_UNIVERSE_DOMAIN,
    };

    admin.initializeApp({
      credential: admin.credential.cert(firebaseParams as admin.ServiceAccount),
    });
    admin.firestore().settings({ ignoreUndefinedProperties: true });
  }
}
