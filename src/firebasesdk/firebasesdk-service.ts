// src/firebasesdk/firebase-auth.service.ts
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import * as admin from 'firebase-admin';
import { EditUnidentifiedPaymentCase } from 'src/cases/maintenance-fees/edit-unidentified-payment.case';
import { MaintenancePaymentCase } from 'src/cases/maintenance-fees/maintenance-fees.case';
import { MaintenanceUnidentifiedPaymentCase } from 'src/cases/maintenance-fees/maintenance-unidentified-payment.case';
import { ParcelReceptionCase } from 'src/cases/parcel/parcel-reception.case';
import { CreatePublicationCase } from 'src/cases/publications/publications.case';
import { RegisterClientCase } from 'src/cases/register-clients/register-clients.case';
import {
  RegisterCondominiumCase,
  syncAdminAccessAcrossClient,
} from 'src/cases/register-condominium-case/register-condominium.case';
import { registerUser } from 'src/cases/users-admon-auth/register-user.case';
import { RegisterCondominiumUsersCase } from 'src/cases/users-condominiums-auth/register-condominiums.case';
import { UpsertCondominiumUsersCase } from 'src/cases/users-condominiums-auth/upsert-condominiums.case';
import { CreateMaintenanceUserCase } from 'src/cases/maintenance-users/create-maintenance-user.case';
import { UpdateMaintenanceUserCase } from 'src/cases/maintenance-users/update-maintenance-user.case';
import { ToolsService } from '../tools/tools.service';
import { StripeService } from '../stripe/stripe.service';
import { WhatsappChatBotService } from '../whatsapp-chat-bot/whatsapp-chat-bot.service';
import { GeminiService } from 'src/gemini/gemini.service';
import { CondominiumUsersService } from '../condominium-users/condominium-users.service';
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
  CreateMaintenanceUserDto,
  UpdateMaintenanceUserDto,
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
  PaginatedResponseDto,
  AttendanceQrRegisterDto,
} from 'src/dtos/tools';
import { PaymentConfirmationDto } from 'src/dtos/whatsapp/payment-confirmation.dto';
import { WhatsappMessageDto } from 'src/dtos/whatsapp/whatsapp-message.dto';
import { UpdateParcelCase } from 'src/cases/parcel/update-parcel.case';
import { Request } from 'express';
import { UpsertActor, UpsertMode } from 'src/dtos/upsert-condominium-users.dto';

@Injectable()
export class FirebaseAuthService {
  private firestore: admin.firestore.Firestore;
  private readonly logger = new Logger(FirebaseAuthService.name);

  constructor(
    private registerCondominiumUsersCase: RegisterCondominiumUsersCase,
    private upsertCondominiumUsersCase: UpsertCondominiumUsersCase,
    private toolsService: ToolsService,
    private stripeService: StripeService,
    private whatsappChatBotService: WhatsappChatBotService,
    private readonly geminiService: GeminiService,
    private readonly condominiumUsersService: CondominiumUsersService,
  ) {
    if (!admin.apps.length) {
      admin.initializeApp();
    }
    this.firestore = admin.firestore();
  }

  async createClient(registerClientCase: RegisterClientDto) {
    const createdClient = await RegisterClientCase(registerClientCase);

    try {
      const billingResult = await this.stripeService.bootstrapClientBilling({
        clientId: createdClient.clientId,
        condominiumId: createdClient.condominiumId,
        adminUid: createdClient.adminUid,
      });

      return {
        ...createdClient,
        billing: billingResult,
      };
    } catch (billingError) {
      this.logger.error(
        `Error al inicializar facturación automática para clientId=${createdClient.clientId}: ${billingError?.message || billingError}`,
      );

      return {
        ...createdClient,
        billing: {
          success: false,
          message: 'Cliente creado, pero la facturación inicial quedó pendiente',
          error: billingError?.message || String(billingError),
        },
      };
    }
  }

  async redeemInitialSetupCoupon(params: {
    coupon: string;
    uid: string;
    email: string;
    clientId: string;
    condominiumId: string;
    role: string;
  }) {
    const normalizedCoupon = String(params.coupon || '').trim().toUpperCase();
    if (normalizedCoupon.length < 8) {
      throw new BadRequestException(
        'El cupón debe tener al menos 8 caracteres.',
      );
    }

    if (!params.clientId || !params.condominiumId) {
      throw new ForbiddenException(
        'No se pudo resolver el cliente o condominio del usuario autenticado.',
      );
    }

    if (params.role !== 'admin') {
      throw new ForbiddenException(
        'Solo el administrador principal puede redimir el cupón inicial.',
      );
    }

    const clientRef = this.firestore.collection('clients').doc(params.clientId);
    const clientDoc = await clientRef.get();

    if (!clientDoc.exists) {
      throw new BadRequestException('No se encontró el cliente.');
    }

    const clientData = clientDoc.data() || {};
    const clientCouponRaw = String(clientData.coupon || '').trim().toUpperCase();
    const clientCouponStatus = String(
      clientData.couponStatus || '',
    ).toLowerCase();
    const isClientCouponRedeemable =
      Boolean(clientCouponRaw) &&
      clientCouponStatus !== 'redeemed' &&
      clientCouponRaw === normalizedCoupon;

    // Si el cupón a nivel cliente no aplica, buscamos el cupón asignado al
    // condominio que el administrador autenticado está utilizando. Esto permite
    // soportar el flujo donde se asigna un cupón al agregar un nuevo condominio
    // a un cliente ya existente.
    const condominiumRef = this.firestore
      .collection('clients')
      .doc(params.clientId)
      .collection('condominiums')
      .doc(params.condominiumId);
    const condominiumDoc = await condominiumRef.get();
    const condominiumData = condominiumDoc.exists
      ? condominiumDoc.data() || {}
      : {};
    const condominiumCouponRaw = String(
      condominiumData.coupon || '',
    )
      .trim()
      .toUpperCase();
    const condominiumCouponStatus = String(
      condominiumData.couponStatus || '',
    ).toLowerCase();
    const isCondominiumCouponRedeemable =
      Boolean(condominiumCouponRaw) &&
      condominiumCouponStatus !== 'redeemed' &&
      condominiumCouponRaw === normalizedCoupon;

    let storedCoupon: string;
    let couponScope: 'client' | 'condominium';

    if (isClientCouponRedeemable) {
      storedCoupon = clientCouponRaw;
      couponScope = 'client';
    } else if (isCondominiumCouponRedeemable) {
      storedCoupon = condominiumCouponRaw;
      couponScope = 'condominium';
    } else {
      const hasAnyCoupon = Boolean(clientCouponRaw) || Boolean(condominiumCouponRaw);
      if (!hasAnyCoupon) {
        throw new BadRequestException(
          'Este cliente no tiene un cupón de regalo asignado.',
        );
      }
      // El cupón existe pero ya fue redimido o el código no coincide.
      const alreadyRedeemed =
        (Boolean(clientCouponRaw) && clientCouponStatus === 'redeemed') ||
        (Boolean(condominiumCouponRaw) &&
          condominiumCouponStatus === 'redeemed');
      if (alreadyRedeemed && clientCouponRaw !== normalizedCoupon && condominiumCouponRaw !== normalizedCoupon) {
        throw new BadRequestException('El cupón ingresado no es válido.');
      }
      if (alreadyRedeemed) {
        throw new BadRequestException(
          'Este cupón ya fue redimido previamente.',
        );
      }
      throw new BadRequestException('El cupón ingresado no es válido.');
    }

    const invoicesRef = this.firestore.collection(
      `clients/${params.clientId}/condominiums/${params.condominiumId}/invoicesGenerated`,
    );
    const pendingSubscriptionInvoices = await invoicesRef
      .where('paymentStatus', 'in', ['pending', 'overdue'])
      .get();

    const batch = this.firestore.batch();
    if (couponScope === 'client') {
      batch.set(
        clientRef,
        {
          coupon: storedCoupon,
          couponStatus: 'redeemed',
          couponRedeemedAt: admin.firestore.FieldValue.serverTimestamp(),
          couponRedeemedBy: params.uid,
          couponRedeemedByEmail: params.email || null,
          initialSetupPaymentBypassed: true,
          initialSetupPaymentPending: false,
          initialSetupPaymentBypassReason: 'gift_coupon',
          initialSetupPaymentBypassCoupon: storedCoupon,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    } else {
      batch.set(
        condominiumRef,
        {
          coupon: storedCoupon,
          couponStatus: 'redeemed',
          couponRedeemedAt: admin.firestore.FieldValue.serverTimestamp(),
          couponRedeemedBy: params.uid,
          couponRedeemedByEmail: params.email || null,
          initialSetupPaymentBypassed: true,
          initialSetupPaymentPending: false,
          initialSetupPaymentBypassReason: 'gift_coupon',
          initialSetupPaymentBypassCoupon: storedCoupon,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }

    const subscriptionInvoiceDocs = pendingSubscriptionInvoices.docs.filter(
      (invoiceDoc) => {
        const invoiceData = invoiceDoc.data() || {};
        const invoiceType = String(invoiceData.invoiceType || '').toLowerCase();
        const concept = String(invoiceData.concept || '').toLowerCase();
        return invoiceType === 'subscription' || concept.includes('suscrip');
      },
    );

    subscriptionInvoiceDocs.forEach((invoiceDoc) => {
      batch.set(
        invoiceDoc.ref,
        {
          status: 'canceled',
          paymentStatus: 'canceled',
          waivedByCoupon: true,
          waivedCoupon: storedCoupon,
          waivedReason: 'gift_coupon',
          waivedAt: admin.firestore.FieldValue.serverTimestamp(),
          waivedBy: params.uid,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    });

    await batch.commit();

    return {
      success: true,
      message: 'Cupón validado correctamente.',
      coupon: storedCoupon,
      couponScope,
      waivedInvoices: subscriptionInvoiceDocs.length,
    };
  }

  /**
   * Asigna un cupón "de rescate" a un cliente o condominio existente.
   *
   * Caso de uso: clientes creados antes de la funcionalidad de cupones, o
   * cuyo administrador no pagó la primera factura y quedó atorado en el
   * paso de pago inicial. El super admin asigna un cupón con estado
   * `active` que después puede redimir el propio administrador desde su
   * dashboard usando el endpoint `redeem-initial-setup-coupon`.
   *
   * Si `condominiumId` se proporciona, el cupón se guarda en el documento
   * del condominio (afecta solo a ese condominio). Si no, se guarda en el
   * documento del cliente (cubre el primer condominio / setup inicial).
   *
   * Si ya existía un cupón redimido en el documento destino, se rechaza la
   * operación para no perder la auditoría — en ese caso el super admin
   * debe revisar manualmente antes de sobrescribir.
   */
  async assignRescueCoupon(params: {
    clientId: string;
    condominiumId?: string;
    coupon: string;
    actorUid: string;
    actorEmail: string;
  }) {
    const normalizedCoupon = String(params.coupon || '').trim().toUpperCase();
    if (normalizedCoupon.length < 8) {
      throw new BadRequestException(
        'El cupón debe tener al menos 8 caracteres.',
      );
    }

    const clientId = String(params.clientId || '').trim();
    if (!clientId) {
      throw new BadRequestException('clientId es obligatorio.');
    }

    const clientRef = this.firestore.collection('clients').doc(clientId);
    const clientDoc = await clientRef.get();
    if (!clientDoc.exists) {
      throw new BadRequestException('No se encontró el cliente indicado.');
    }

    const normalizedCondominiumId = String(
      params.condominiumId || '',
    ).trim();

    let targetRef: admin.firestore.DocumentReference;
    let scope: 'client' | 'condominium';
    let existingData: admin.firestore.DocumentData;

    if (normalizedCondominiumId) {
      const condominiumRef = clientRef
        .collection('condominiums')
        .doc(normalizedCondominiumId);
      const condominiumDoc = await condominiumRef.get();
      if (!condominiumDoc.exists) {
        throw new BadRequestException(
          'No se encontró el condominio indicado para el cliente.',
        );
      }
      targetRef = condominiumRef;
      scope = 'condominium';
      existingData = condominiumDoc.data() || {};
    } else {
      targetRef = clientRef;
      scope = 'client';
      existingData = clientDoc.data() || {};
    }

    const existingCouponStatus = String(
      existingData.couponStatus || '',
    ).toLowerCase();
    if (existingCouponStatus === 'redeemed') {
      throw new BadRequestException(
        scope === 'client'
          ? 'Este cliente ya tiene un cupón redimido. Revisa el caso antes de asignar uno nuevo.'
          : 'Este condominio ya tiene un cupón redimido. Revisa el caso antes de asignar uno nuevo.',
      );
    }

    const couponPayload: Record<string, any> = {
      coupon: normalizedCoupon,
      couponStatus: 'active',
      couponType: 'rescue',
      couponCreatedAt: admin.firestore.FieldValue.serverTimestamp(),
      couponCreatedBy: params.actorUid,
      couponCreatedByEmail: params.actorEmail || null,
      // Limpiamos cualquier estado previo de redención / bypass parcial,
      // para que el cupón quede listo para redimirse.
      couponRedeemedAt: admin.firestore.FieldValue.delete(),
      couponRedeemedBy: admin.firestore.FieldValue.delete(),
      couponRedeemedByEmail: admin.firestore.FieldValue.delete(),
      initialSetupPaymentBypassed: false,
      initialSetupPaymentBypassReason:
        admin.firestore.FieldValue.delete(),
      initialSetupPaymentBypassCoupon:
        admin.firestore.FieldValue.delete(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    // El cast a any es necesario porque FieldValue.delete() no es asignable
    // al tipo de set en algunas versiones de @types/firebase-admin.
    await targetRef.set(couponPayload as any, { merge: true });

    this.logger.log(
      `[assign-rescue-coupon] scope=${scope} clientId=${clientId} condominiumId=${normalizedCondominiumId || '-'} coupon=${normalizedCoupon} actor=${params.actorUid}`,
    );

    return {
      success: true,
      message:
        scope === 'client'
          ? 'Cupón de rescate asignado al cliente. El administrador puede redimirlo desde su dashboard.'
          : 'Cupón de rescate asignado al condominio. El administrador puede redimirlo desde su dashboard.',
      coupon: normalizedCoupon,
      scope,
    };
  }

  /**
   * Regulariza el acceso de los administradores del cliente: garantiza que
   * todos los usuarios con rol `admin` del cliente tengan en su array
   * `condominiumUids` cada uno de los condominios del cliente, y replica su
   * doc dentro de la subcolección users de cada condominio.
   *
   * Usado para clientes creados antes del fix de propagación automática en
   * register-condominium.
   */
  async syncAdminCondominiums(params: { clientId: string }) {
    const clientId = String(params.clientId || '').trim();
    if (!clientId) {
      throw new BadRequestException('clientId es obligatorio.');
    }

    const clientRef = this.firestore.collection('clients').doc(clientId);
    const clientDoc = await clientRef.get();
    if (!clientDoc.exists) {
      throw new BadRequestException('No se encontró el cliente indicado.');
    }

    const result = await syncAdminAccessAcrossClient({ clientId });

    this.logger.log(
      `[sync-admin-condominiums] clientId=${clientId} condominiums=${result.condominiumsScanned} adminUsersUpdated=${result.adminUsersUpdated}`,
    );

    return {
      success: true,
      message:
        result.adminUsersUpdated > 0
          ? 'Permisos de administradores sincronizados con todos los condominios del cliente.'
          : 'No se encontraron administradores que sincronizar.',
      ...result,
    };
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

  async assertCondominiumInClient(
    clientId: string,
    condominiumId: string,
  ): Promise<void> {
    return this.upsertCondominiumUsersCase.assertCondominiumInClient(
      clientId,
      condominiumId,
    );
  }

  async upsertCondominiumUsersDryRun(params: {
    fileBuffer: Buffer;
    originalFileName?: string;
    clientId: string;
    condominiumId: string;
    mode?: UpsertMode;
    optionsJson?: string;
    actor: UpsertActor;
    sourceIp?: string;
  }) {
    return this.upsertCondominiumUsersCase.executeDryRun(params);
  }

  async upsertCondominiumUsersCommit(params: {
    fileBuffer: Buffer;
    originalFileName?: string;
    clientId: string;
    condominiumId: string;
    operationId: string;
    actor: UpsertActor;
    sourceIp?: string;
  }) {
    return this.upsertCondominiumUsersCase.executeCommit(params);
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
    const createdCondominium = await RegisterCondominiumCase(
      registerCondominiumDto,
    );

    try {
      const clientDoc = await this.firestore
        .collection('clients')
        .doc(registerCondominiumDto.clientId)
        .get();
      const clientData = clientDoc.data() || {};

      const billingResult = await this.stripeService.bootstrapClientBilling({
        clientId: registerCondominiumDto.clientId,
        condominiumId: createdCondominium.id,
        adminUid: String(clientData.ownerAdminUid || ''),
      });

      return {
        ...createdCondominium,
        billing: billingResult,
      };
    } catch (billingError) {
      this.logger.error(
        `Error al inicializar facturación automática para condominio ${createdCondominium.id}: ${billingError?.message || billingError}`,
      );

      return {
        ...createdCondominium,
        billing: {
          success: false,
          message:
            'Condominio creado, pero la facturación inicial quedó pendiente',
          error: billingError?.message || String(billingError),
        },
      };
    }
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

  async validatePublicAttendanceQr(
    qrId: string,
    clientId: string,
    condominiumId: string,
  ) {
    return await this.toolsService.validatePublicAttendanceQr(
      qrId,
      clientId,
      condominiumId,
    );
  }

  async registerAttendanceFromPublicQr(
    qrId: string,
    payload: AttendanceQrRegisterDto,
    req: Request,
  ) {
    return await this.toolsService.registerAttendanceFromPublicQr(
      qrId,
      payload,
      req,
    );
  }

  async createMaintenanceUser(
    createMaintenanceUserDto: CreateMaintenanceUserDto,
    photoFile?: Express.Multer.File,
  ) {
    return await CreateMaintenanceUserCase(createMaintenanceUserDto, photoFile);
  }

  async updateMaintenanceUser(
    updateMaintenanceUserDto: UpdateMaintenanceUserDto,
    photoFile?: Express.Multer.File,
  ) {
    return await UpdateMaintenanceUserCase(updateMaintenanceUserDto, photoFile);
  }
}
