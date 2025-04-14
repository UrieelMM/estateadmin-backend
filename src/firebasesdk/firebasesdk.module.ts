import * as admin from 'firebase-admin';
import { Module } from '@nestjs/common';
import { FirebaseAuthService } from './firebasesdk-service';
import { RegisterCondominiumUsersCase } from '../cases/users-condominiums-auth/register-condominiums.case';
import * as dotenv from 'dotenv';
import { ToolsModule } from '../tools/tools.module';
import { StripeModule } from '../stripe/stripe.module';
import { WhatsappChatBotModule } from '../whatsapp-chat-bot/whatsapp-chat-bot.module';

dotenv.config();
@Module({
  imports: [ToolsModule, StripeModule, WhatsappChatBotModule],
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
