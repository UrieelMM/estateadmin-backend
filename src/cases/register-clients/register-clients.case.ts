import * as admin from 'firebase-admin';
import {
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import {
  RegisterClientDto,
  BillingFrequency,
  CondominiumStatus,
} from 'src/dtos/register-client.dto';
import { v4 as uuidv4 } from 'uuid';

export const RegisterClientCase = async (
  registerClientDto: RegisterClientDto,
) => {
  const {
    email,
    password,
    phoneNumber,
    plan = '',
    pricing,
    pricingWithoutTax,
    pricingWithoutIVA,
    pricingWithoutIva,
    proFunctions = [],
    address,
    fullFiscalAddress,
    RFC,
    country,
    businessName,
    taxRegime,
    companyName,
    businessActivity,
    responsiblePersonName,
    responsiblePersonPosition,
    cfdiUse,
    serviceStartDate = new Date(),
    billingFrequency = BillingFrequency.Monthly,
    condominiumLimit,
    termsAccepted = true,
    condominiumInfo,
    condominiumManager,
    currency = 'MXN',
    language = 'es-MX',
    hasMaintenanceApp,
  } = registerClientDto;

  const normalizePricingValue = (value: unknown): number | string | null => {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : null;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) {
        return null;
      }
      const numeric = Number(trimmed.replace(/,/g, ''));
      return Number.isFinite(numeric) ? numeric : trimmed;
    }
    return null;
  };
  const roundToTwo = (value: number): number =>
    Math.round((value + Number.EPSILON) * 100) / 100;
  const extractNumericPricing = (value: number | string | null): number | null => {
    if (typeof value === 'number') {
      return Number.isFinite(value) && value > 0 ? value : null;
    }
    if (typeof value === 'string') {
      const numeric = Number(value.replace(/[^0-9.,-]/g, '').replace(/,/g, ''));
      return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
    }
    return null;
  };

  const resolvedPricing = normalizePricingValue(pricing);
  const explicitPricingWithoutTax =
    normalizePricingValue(pricingWithoutTax) ??
    normalizePricingValue(pricingWithoutIVA) ??
    normalizePricingValue(pricingWithoutIva);
  const pricingNumeric = extractNumericPricing(resolvedPricing);
  const fallbackPricingWithoutTax =
    pricingNumeric && pricingNumeric > 0
      ? roundToTwo(pricingNumeric / 1.16)
      : null;
  const resolvedPricingWithoutTax =
    explicitPricingWithoutTax ??
    fallbackPricingWithoutTax ??
    resolvedPricing;
  const resolvedCondominiumManager =
    String(
      condominiumInfo?.condominiumManager || condominiumManager || '',
    ).trim() || null;

  const clientRecord = uuidv4();
  const registrationDate = new Date();
  const billingAnchorDay = registrationDate.getDate();
  const initialNextBillingDate =
    admin.firestore.Timestamp.fromDate(registrationDate);

  try {
    // Primero crear el usuario en Firebase Auth para asegurar que no hay conflictos
    // antes de escribir datos en Firestore
    let userRecord;
    try {
      userRecord = await admin.auth().createUser({
        email,
        password,
      });
    } catch (authError) {
      // Si falla la creación del usuario en Auth, lanzar error sin crear datos en Firestore
      console.error('Error al crear usuario en Firebase Auth:', authError);
      if (authError.code === 'auth/email-already-exists') {
        throw new BadRequestException(
          'El correo electrónico ya está registrado.',
        );
      } else {
        throw new BadRequestException(
          `Error al crear la cuenta: ${authError.message}`,
        );
      }
    }

    console.log(condominiumInfo);
    const clientProfileRef = admin
      .firestore()
      .collection('clients')
      .doc(clientRecord);

    // Generar un UID único para el condominio
    const condominiumUid = uuidv4();

    const clientData = {
      uid: clientRecord,
      email,
      companyName, // Razón social
      phoneNumber,
      address, // Mantenemos para compatibilidad
      fullFiscalAddress, // Nuevo campo para domicilio fiscal completo
      RFC,
      country,
      businessName,
      businessActivity, // Giro o actividad económica
      taxRegime, // Régimen fiscal
      responsiblePersonName, // Nombre de la persona responsable
      responsiblePersonPosition, // Cargo de la persona responsable
      cfdiUse, // Uso de CFDI (opcional)
      serviceStartDate, // Fecha de inicio de servicio
      billingFrequency, // Periodicidad de facturación
      termsAccepted, // Aceptación de términos y condiciones
      plan,
      pricing: resolvedPricing,
      pricingWithoutTax: resolvedPricingWithoutTax,
      condominiumLimit,
      createdDate: admin.firestore.FieldValue.serverTimestamp(),
      status: 'active',
      billingAnchorDay,
      nextBillingDate: initialNextBillingDate,
      stripeCustomerId: null,
      ownerAdminUid: userRecord.uid,
      ownerEmail: email,
      defaultCondominiumId: condominiumUid,
      condominiumsUids: [condominiumUid],
      currency, // Utilizamos la variable extraída de la desestructuración
      language, // Utilizamos la variable extraída de la desestructuración
      hasMaintenanceApp, // Indica si el cliente tiene la app de mantenimiento
    };
    await clientProfileRef.set(clientData);

    const condominiumRef = admin
      .firestore()
      .collection(`clients/${clientRecord}/condominiums`)
      .doc(condominiumUid);
    await condominiumRef.set({
      name: condominiumInfo.name,
      address: condominiumInfo.address,
      condominiumManager: resolvedCondominiumManager,
      uid: condominiumUid,
      plan,
      pricing: resolvedPricing,
      pricingWithoutTax: resolvedPricingWithoutTax,
      proFunctions,
      condominiumLimit, // Límite de condominios según el plan
      status: CondominiumStatus.Pending, // Estado inicial del condominio
      createdDate: admin.firestore.FieldValue.serverTimestamp(),
    });

    await admin.auth().setCustomUserClaims(userRecord.uid, {
      clientId: clientRecord,
      role: 'admin',
      condominiumId: condominiumUid,
    });

    // Registrar el perfil del administrador dentro del condominio
    const adminProfileRef = condominiumRef
      .collection('users')
      .doc(userRecord.uid);
    const adminProfileData = {
      uid: userRecord.uid,
      name: registerClientDto.name,
      lastName: registerClientDto.lastName,
      companyName: registerClientDto.companyName,
      photoUrl: registerClientDto.photoURL || '',
      condominiumUids: [condominiumUid],
      email,
      role: 'admin',
      createdDate: admin.firestore.FieldValue.serverTimestamp(),
    };
    await adminProfileRef.set(adminProfileData);

    return {
      clientData,
      adminProfileData,
      condominiumInfo,
      clientId: clientRecord,
      condominiumId: condominiumUid,
      adminUid: userRecord.uid,
      registrationDate: registrationDate.toISOString(),
    };
  } catch (error) {
    console.error(
      'Error al registrar el cliente y su cuenta administrativa',
      error,
    );

    // Si ya se creó el usuario de autenticación pero falló algo más,
    // intentamos eliminar el usuario para evitar inconsistencias
    try {
      if (error.response && error.response.data && error.response.data.uid) {
        await admin.auth().deleteUser(error.response.data.uid);
      }
    } catch (cleanupError) {
      console.error('Error al limpiar usuario de autenticación:', cleanupError);
    }

    if (error instanceof BadRequestException) {
      throw error; // Rethrow validation errors
    } else {
      throw new InternalServerErrorException(
        'Error al registrar el cliente y su cuenta administrativa. Intente más tarde.',
      );
    }
  }
};
