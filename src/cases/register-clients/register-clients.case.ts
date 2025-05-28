import * as admin from 'firebase-admin';
import {
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import {
  RegisterClientDto,
  PlanType,
  BillingFrequency,
  CondominiumStatus,
} from 'src/dtos/register-client.dto';
import { v4 as uuidv4 } from 'uuid';

// Función de validación para límites de condominios según el plan
const validateCondominiumLimit = (plan: PlanType, condominiumLimit: number) => {
  switch (plan) {
    case PlanType.Basic:
      if (condominiumLimit < 1 || condominiumLimit > 50) {
        throw new BadRequestException(
          'El plan Basic permite entre 1 y 50 condominios',
        );
      }
      break;
    case PlanType.Essential:
      if (condominiumLimit < 51 || condominiumLimit > 100) {
        throw new BadRequestException(
          'El plan Essential permite entre 51 y 100 condominios',
        );
      }
      break;
    case PlanType.Professional:
      if (condominiumLimit < 101 || condominiumLimit > 250) {
        throw new BadRequestException(
          'El plan Professional permite entre 101 y 250 condominios',
        );
      }
      break;
    case PlanType.Premium:
      if (condominiumLimit < 251 || condominiumLimit > 500) {
        throw new BadRequestException(
          'El plan Premium permite entre 251 y 500 condominios',
        );
      }
      break;
    default:
      throw new BadRequestException('Plan no válido');
  }
};

export const RegisterClientCase = async (
  registerClientDto: RegisterClientDto,
) => {
  const {
    email,
    password,
    phoneNumber,
    plan = PlanType.Basic,
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
    currency = 'MXN',
    language = 'es-MX',
  } = registerClientDto;

  // Validar el límite de condominios según el plan
  validateCondominiumLimit(plan, condominiumLimit);

  const clientRecord = uuidv4();

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
      createdDate: admin.firestore.FieldValue.serverTimestamp(),
      condominiumsUids: [condominiumUid],
      currency, // Utilizamos la variable extraída de la desestructuración
      language, // Utilizamos la variable extraída de la desestructuración
    };
    await clientProfileRef.set(clientData);

    const condominiumRef = admin
      .firestore()
      .collection(`clients/${clientRecord}/condominiums`)
      .doc(condominiumUid);
    await condominiumRef.set({
      name: condominiumInfo.name,
      address: condominiumInfo.address,
      uid: condominiumUid,
      plan,
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

    // Función de validación para límites de condominios según el plan
    const validateCondominiumLimit = (
      plan: PlanType,
      condominiumLimit: number,
    ) => {
      switch (plan) {
        case PlanType.Basic:
          if (condominiumLimit < 1 || condominiumLimit > 50) {
            throw new BadRequestException(
              'El plan Basic permite entre 1 y 50 condominios',
            );
          }
          break;
        case PlanType.Essential:
          if (condominiumLimit < 51 || condominiumLimit > 100) {
            throw new BadRequestException(
              'El plan Essential permite entre 51 y 100 condominios',
            );
          }
          break;
        case PlanType.Professional:
          if (condominiumLimit < 101 || condominiumLimit > 250) {
            throw new BadRequestException(
              'El plan Professional permite entre 101 y 250 condominios',
            );
          }
          break;
        case PlanType.Premium:
          if (condominiumLimit < 251 || condominiumLimit > 500) {
            throw new BadRequestException(
              'El plan Premium permite entre 251 y 500 condominios',
            );
          }
          break;
        default:
          throw new BadRequestException('Plan no válido');
      }
    };
    await adminProfileRef.set(adminProfileData);

    return { clientData, adminProfileData, condominiumInfo };
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
