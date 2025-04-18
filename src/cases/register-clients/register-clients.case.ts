import * as admin from 'firebase-admin';
import { InternalServerErrorException } from '@nestjs/common';
import { RegisterClientDto, PlanType } from 'src/dtos/register-client.dto';
import { v4 as uuidv4 } from 'uuid';

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
    RFC,
    country,
    businessName,
    taxResidence,
    taxRegime,
    companyName,
    condominiumInfo,
  } = registerClientDto;

  const clientRecord = uuidv4();

  try {
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
      companyName,
      phoneNumber,
      address,
      RFC,
      country,
      businessName,
      taxResidence,
      taxRegime,
      createdDate: admin.firestore.FieldValue.serverTimestamp(),
      condominiumsUids: [condominiumUid],
    };
    await clientProfileRef.set(clientData);

    const userRecord = await admin.auth().createUser({
      email,
      password,
    });

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

    return { clientData, adminProfileData, condominiumInfo };
  } catch (error) {
    console.error(
      'Error al registrar el cliente y su cuenta administrativa',
      error,
    );
    throw new InternalServerErrorException(
      'Error al registrar el cliente y su cuenta administrativa. Intente más tarde.',
    );
  }
};
