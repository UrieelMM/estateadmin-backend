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
import { CondominiumUsersService } from '../condominium-users/condominium-users.service';
import { AiContextService } from '../ai-context/ai-context.service';
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
import { CondominiumLimitResponseDto } from 'src/dtos/tools/condominium-limit.dto';
import { 
  NewCustomerInfoDto, 
  FormExpirationResponseDto, 
  FormUrlDto, 
  FormUrlResponseDto,
  PaginatedResponseDto
} from 'src/dtos/tools';
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
    private readonly condominiumUsersService: CondominiumUsersService,
    private readonly aiContextService: AiContextService,
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

  async getCondominiumLimit(
    clientId: string,
    condominiumId: string,
  ): Promise<CondominiumLimitResponseDto> {
    return await this.condominiumUsersService.getCondominiumLimit(clientId, condominiumId);
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
      this.logger.log(
        `Generating text with Gemini for prompt: "${prompt.substring(0, 30)}..."`,
        context,
      );
      const result = await this.geminiService.generateContent(prompt);
      this.logger.log(`Successfully generated text with Gemini`, context);
      return result;
    } catch (error) {
      this.logger.error(
        `Error generating text with Gemini: ${error.message}`,
        error.stack,
        context,
      );
      throw error; // Re-throw the error to be handled by the caller
    }
  }

  async updateParcelDelivery(updateParcelDto: UpdateParcelDto, files: any) {
    return await UpdateParcelCase(updateParcelDto, files);
  }

  /**
   * Registra información de nuevos clientes en el sistema
   * @param newCustomerInfoDto Información del nuevo cliente
   * @returns Resultado de la operación
   */
  async submitNewCustomerInfo(newCustomerInfoDto: NewCustomerInfoDto) {
    const context = 'FirebaseAuthService | submitNewCustomerInfo';
    try {
      this.logger.log(
        `Registrando información de nuevo cliente: ${newCustomerInfoDto.name} ${newCustomerInfoDto.lastName}`,
        context,
      );
      
      // Delega la operación al servicio de herramientas
      const result = await this.toolsService.submitNewCustomerInfo(newCustomerInfoDto);
      
      this.logger.log(
        `Cliente registrado exitosamente con ID: ${result.id}`,
        context,
      );
      
      return result;
    } catch (error) {
      this.logger.error(
        `Error al registrar información de nuevo cliente: ${error.message}`,
        error.stack,
        context,
      );
      throw error; // Re-throw the error to be handled by the caller
    }
  }
  
  /**
   * Verifica si un formulario de registro de cliente ha expirado
   * @param formId ID del formulario a verificar
   * @returns Información sobre el estado de expiración del formulario
   */
  async checkFormExpiration(formId: string): Promise<FormExpirationResponseDto> {
    const context = 'FirebaseAuthService | checkFormExpiration';
    try {
      this.logger.log(
        `Verificando expiración del formulario con ID: ${formId}`,
        context,
      );
      
      // Delega la operación al servicio de herramientas
      const result = await this.toolsService.checkFormExpiration(formId);
      
      this.logger.log(
        `Estado de expiración verificado: ${result.expired ? 'Expirado' : 'Válido'}`,
        context,
      );
      
      return result;
    } catch (error) {
      this.logger.error(
        `Error al verificar expiración del formulario: ${error.message}`,
        error.stack,
        context,
      );
      throw error; // Re-throw the error to be handled by the caller
    }
  }
  
  /**
   * Obtiene información de clientes paginada
   * @param page Número de página a obtener
   * @param perPage Cantidad de elementos por página
   * @returns Información de clientes paginada
   */
  async getCustomerInformation(page: number = 1, perPage: number = 10): Promise<PaginatedResponseDto<any>> {
    const context = 'FirebaseAuthService | getCustomerInformation';
    try {
      this.logger.log(
        `Obteniendo información de clientes: página ${page}, ${perPage} por página`,
        context,
      );
      
      // Delega la operación al servicio de herramientas
      const result = await this.toolsService.getCustomerInformation(page, perPage);
      
      this.logger.log(
        `Obtenidos ${result.data.length} registros de clientes de un total de ${result.meta.totalItems}`,
        context,
      );
      
      return result;
    } catch (error) {
      this.logger.error(
        `Error al obtener información de clientes: ${error.message}`,
        error.stack,
        context,
      );
      throw error; // Re-throw the error to be handled by the caller
    }
  }
  
  /**
   * Obtiene URLs de formularios paginadas
   * @param page Número de página a obtener
   * @param perPage Cantidad de elementos por página
   * @returns URLs de formularios paginadas
   */
  async getFormUrls(page: number = 1, perPage: number = 10): Promise<PaginatedResponseDto<any>> {
    const context = 'FirebaseAuthService | getFormUrls';
    try {
      this.logger.log(
        `Obteniendo URLs de formularios: página ${page}, ${perPage} por página`,
        context,
      );
      
      // Delega la operación al servicio de herramientas
      const result = await this.toolsService.getFormUrls(page, perPage);
      
      this.logger.log(
        `Obtenidas ${result.data.length} URLs de formularios de un total de ${result.meta.totalItems}`,
        context,
      );
      
      return result;
    } catch (error) {
      this.logger.error(
        `Error al obtener URLs de formularios: ${error.message}`,
        error.stack,
        context,
      );
      throw error; // Re-throw the error to be handled by the caller
    }
  }
  
  /**
   * Genera y registra una URL de formulario para compartir con clientes
   * @param formUrlDto DTO con la información de la URL a generar
   * @returns Información sobre la URL generada
   */
  async generateFormUrl(formUrlDto: FormUrlDto): Promise<FormUrlResponseDto> {
    const context = 'FirebaseAuthService | generateFormUrl';
    try {
      this.logger.log(
        `Generando URL para el formulario con ID: ${formUrlDto.formId}`,
        context,
      );
      
      // Delega la operación al servicio de herramientas
      const result = await this.toolsService.generateFormUrl(formUrlDto);
      
      this.logger.log(
        `URL de formulario generada exitosamente para: ${formUrlDto.formId}`,
        context,
      );
      
      return result;
    } catch (error) {
      this.logger.error(
        `Error al generar URL del formulario: ${error.message}`,
        error.stack,
        context,
      );
      throw error; // Re-throw the error to be handled by the caller
    }
  }
}
