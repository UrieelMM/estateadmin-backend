import * as admin from 'firebase-admin';
import { EditUserDto } from '../../dtos/edit-user.dto';
import { InternalServerErrorException } from '@nestjs/common';

export const editUser = async (uid: string, clientId: string, editUserDto: EditUserDto) => {
  const { 
    name, 
    lastName, 
    condominiumUids, 
    role,
    active 
  } = editUserDto;

  try {
    // Actualizar claims del usuario
    await admin.auth().setCustomUserClaims(uid, { 
      clientId,
      role,
      condominiumId: condominiumUids[0]
    });

    // Actualizar el perfil del usuario en Firestore
    const userProfileRef = admin.firestore()
      .collection(`clients/${clientId}/condominiums/${condominiumUids[0]}/users`)
      .doc(uid);

    const userProfile = {
      name,
      lastName,
      role,
      active,
      condominiumUids,
      updatedDate: admin.firestore.FieldValue.serverTimestamp(),
    };

    await userProfileRef.update(userProfile);

    return userProfile;
  } catch (error) {
    console.error('Error al editar el usuario', error);
    throw new InternalServerErrorException('Error al editar el usuario. Intente más tarde');
  }
}; 