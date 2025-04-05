import * as admin from 'firebase-admin';
import { v4 as uuidv4 } from 'uuid';
import { PlanType } from 'src/dtos/register-client.dto';

export const RegisterCondominiumCase = async (condominiumData: {
  name: string;
  address: string;
  clientId: string;
  plan?: PlanType;
  proFunctions?: string[];
}) => {
  try {
    const {
      name,
      address,
      clientId,
      plan = PlanType.Basic,
      proFunctions = [],
    } = condominiumData;
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
        proFunctions,
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
      proFunctions,
      message: 'Condominio creado exitosamente',
    };
  } catch (error) {
    throw new Error(`Error al crear el condominio: ${error.message}`);
  }
};
