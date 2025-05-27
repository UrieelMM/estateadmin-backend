import * as admin from 'firebase-admin';
import { v4 as uuidv4 } from 'uuid';
import { BadRequestException } from '@nestjs/common';
import { PlanType, CondominiumStatus } from 'src/dtos/register-client.dto';

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

export const RegisterCondominiumCase = async (condominiumData: {
  name: string;
  address: string;
  clientId: string;
  plan: PlanType;
  condominiumLimit: number;
  status: CondominiumStatus;
  proFunctions?: string[];
  currency?: string;
  language?: string;
}) => {
  try {
    const {
      name,
      address,
      clientId,
      plan,
      condominiumLimit,
      status = CondominiumStatus.Pending,
      proFunctions = [],
      currency = 'MXN',
      language = 'es-MX',
    } = condominiumData;

    // Validar el límite de condominios según el plan
    validateCondominiumLimit(plan, condominiumLimit);
    const uid = uuidv4(); // Generamos el UID único

    // Verificar que el cliente existe
    const clientDoc = await admin
      .firestore()
      .collection('clients')
      .doc(clientId)
      .get();

    if (!clientDoc.exists) {
      throw new Error('Cliente no encontrado');
    }

    // Crear el nuevo condominio
    await admin
      .firestore()
      .collection('clients')
      .doc(clientId)
      .collection('condominiums')
      .doc(uid)
      .set({
        uid,
        name,
        address,
        plan,
        condominiumLimit,
        status,
        proFunctions,
        currency,
        language,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    // Actualizar el perfil del cliente con el UID del nuevo condominio
    await admin
      .firestore()
      .collection('clients')
      .doc(clientId)
      .update({
        condominiumUids: admin.firestore.FieldValue.arrayUnion(uid),
      });

    return {
      id: uid,
      name,
      address,
      plan,
      condominiumLimit,
      status,
      proFunctions,
      currency,
      language,
      message: 'Condominio creado exitosamente',
    };
  } catch (error) {
    throw new Error(`Error al crear el condominio: ${error.message}`);
  }
};
