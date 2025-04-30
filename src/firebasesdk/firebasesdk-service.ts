// src/firebasesdk/firebase-auth.service.ts
import { Injectable, Logger } from '@nestjs/common';
import * as admin from 'firebase-admin';
import { EditUnidentifiedPaymentCase } from 'src/cases/maintenance-fees/edit-unidentified-payment.case';
import { MaintenancePaymentCase } from 'src/cases/maintenance-fees/maintenance-fees.case';
import { MaintenanceUnidentifiedPaymentCase } from 'src/cases/maintenance-fees/maintenance-unidentified-payment.case';
import { ParcelReceptionCase } from 'src/cases/parcel/parcel-reception.case';
import { CreatePublicationCase } from 'src/cases/publications/publications.case';
import { RegisterClientCase } from 'src/cases/register-clients/register-clients.case';
import { RegisterCondominiumCase } from 'src/cases/register-condominium-case/register-condominium.case';
import { registerUser } from 'src/cases/users-admon-auth/register-user.case';
import { RegisterCondominiumUsersCase } from 'src/cases/users-condominiums-auth/register-condominiums.case';
import { ToolsService } from '../tools/tools.service';
import { StripeService } from '../stripe/stripe.service';
import { WhatsappChatBotService } from '../whatsapp-chat-bot/whatsapp-chat-bot.service';
import { GeminiService } from 'src/gemini/gemini.service';
import {
  RegisterUserDto,
  RegisterClientDto,
  CreatePublicationDto,
  ParcelDto,
  MaintenanceFeesDto,
  CreateUnidentifiedPaymentDto,
  EditUnidentifiedPaymentDto,
  EditUserDto,
  ResetPasswordDto,
  ConfirmResetPasswordDto,
  UpdateParcelDto,
} from 'src/dtos';
import { RegisterCondominiumDto } from 'src/dtos/register-condominium.dto';
import { editUser } from 'src/cases/users-admon-auth/edit-user.case';
import { resetPassword } from 'src/cases/users-admon-auth/reset-password.case';
import { confirmResetPassword } from 'src/cases/users-admon-auth/confirm-reset-password.case';
import { RegisterSuperAdminDto } from 'src/dtos/register-super-admin.dto';
import { registerSuperAdmin } from 'src/cases/users-admon-auth/register-super-admin.case';
import { ClientPlanResponseDto } from 'src/dtos/client-plan.dto';
import { PaymentConfirmationDto } from 'src/dtos/whatsapp/payment-confirmation.dto';
import { WhatsappMessageDto } from 'src/dtos/whatsapp/whatsapp-message.dto';
import { UpdateParcelCase } from 'src/cases/parcel/update-parcel.case';

@Injectable()
export class FirebaseAuthService {
  private firestore: admin.firestore.Firestore;
  private readonly logger = new Logger(FirebaseAuthService.name);

  constructor(
    private registerCondominiumUsersCase: RegisterCondominiumUsersCase,
    private toolsService: ToolsService,
    private stripeService: StripeService,
    private whatsappChatBotService: WhatsappChatBotService,
    private readonly geminiService: GeminiService,
  ) {
    if (!admin.apps.length) {
      admin.initializeApp();
    }
    this.firestore = admin.firestore();
  }

  async createClient(registerClientCase: RegisterClientDto) {
    return await RegisterClientCase(registerClientCase);
  }

  async createUserWithEmail(registerUserDto: RegisterUserDto) {
    return await registerUser(registerUserDto);
  }

  async editUser(uid: string, clientId: string, editUserDto: EditUserDto) {
    return await editUser(uid, clientId, editUserDto);
  }

  async resetPassword(resetPasswordDto: ResetPasswordDto) {
    return await resetPassword(resetPasswordDto);
  }

  async registerCondominiumUsers(
    fileBuffer: Buffer,
    companyName: string,
    condominiumName: string,
  ) {
    return this.registerCondominiumUsersCase.execute(
      fileBuffer,
      companyName,
      condominiumName,
    );
  }

  async createPublication(
    createPublicationDto: CreatePublicationDto,
    files: any,
  ) {
    return await CreatePublicationCase(createPublicationDto, files);
  }

  async createParcelReception(createParcelReceptionDto: ParcelDto, files: any) {
    return await ParcelReceptionCase(createParcelReceptionDto, files);
  }

  async createMaintenanceFee(
    createMaintenanceFeeDto: MaintenanceFeesDto,
    files: any,
  ) {
    return await MaintenancePaymentCase(createMaintenanceFeeDto, files);
  }

  async createUnidentifiedPayment(
    createUnidentifiedPaymentDto: CreateUnidentifiedPaymentDto,
    files: any,
  ) {
    return await MaintenanceUnidentifiedPaymentCase(
      createUnidentifiedPaymentDto,
      files,
    );
  }

  async editUnidentifiedPayment(
    editUnidentifiedPaymentDto: EditUnidentifiedPaymentDto,
  ) {
    return await EditUnidentifiedPaymentCase(editUnidentifiedPaymentDto);
  }

  async createCondominium(registerCondominiumDto: RegisterCondominiumDto) {
    return await RegisterCondominiumCase(registerCondominiumDto);
  }

  async confirmResetPassword(confirmResetPasswordDto: ConfirmResetPasswordDto) {
    return await confirmResetPassword(confirmResetPasswordDto);
  }

  async createSuperAdmin(registerSuperAdminDto: RegisterSuperAdminDto) {
    return await registerSuperAdmin(registerSuperAdminDto);
  }

  async getClientPlan(
    clientId: string,
    condominiumId: string,
  ): Promise<ClientPlanResponseDto> {
    return await this.toolsService.getClientPlan(clientId, condominiumId);
  }

  async searchPlaces(
    latitude: number,
    longitude: number,
    keyword: string,
    radius: number,
  ) {
    return await this.toolsService.searchPlaces(
      latitude,
      longitude,
      keyword,
      radius,
    );
  }

  /**
   * Crear una sesión de checkout de Stripe para pagar una factura
   */
  async createStripeCheckoutSession(params: {
    invoiceId: string;
    clientId: string;
    condominiumId: string;
    amount: number;
    invoiceNumber: string;
    userEmail: string;
    description?: string;
    successUrl: string;
    cancelUrl: string;
  }) {
    return await this.stripeService.createCheckoutSession(params);
  }

  /**
   * Verificar el estado de una sesión de pago
   */
  async checkStripeSessionStatus(sessionId: string) {
    return await this.stripeService.checkSessionStatus(sessionId);
  }

  async confirmPayment(paymentDto: PaymentConfirmationDto) {
    return await this.whatsappChatBotService.confirmPayment(paymentDto);
  }

  async sendMessage(whatsappMessageDto: WhatsappMessageDto) {
    return await this.whatsappChatBotService.sendAndLogMessage(
      whatsappMessageDto,
    );
  }

  async processWebhook(webhookData: any) {
    return await this.whatsappChatBotService.processWebhook(webhookData);
  }

  async generateTextWithGemini(prompt: string): Promise<string> {
    const context = 'FirebaseAuthService | generateTextWithGemini';
    try {
      this.logger.log(`Generating text with Gemini for prompt: "${prompt.substring(0, 30)}..."`, context);
      const result = await this.geminiService.generateContent(prompt);
      this.logger.log(`Successfully generated text with Gemini`, context);
      return result;
    } catch (error) {
      this.logger.error(`Error generating text with Gemini: ${error.message}`, error.stack, context);
      throw error; // Re-throw the error to be handled by the caller
    }
  }

  async updateParcelDelivery(updateParcelDto: UpdateParcelDto, files: any) {
    return await UpdateParcelCase(updateParcelDto, files);
  }
}
