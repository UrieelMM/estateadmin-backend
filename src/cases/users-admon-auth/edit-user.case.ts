import * as admin from 'firebase-admin';
import { EditUserDto } from '../../dtos/edit-user.dto';
import {
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';

export const editUser = async (uid: string, clientId: string, editUserDto: EditUserDto) => {
  const { 
    email,
    name, 
    lastName, 
    condominiumUids, 
    role,
    active,
    photoURL,
  } = editUserDto;

  try {
    if (!Array.isArray(condominiumUids) || !condominiumUids.length) {
      throw new BadRequestException(
        'Debes enviar al menos un condominiumUid.',
      );
    }

    await admin.auth().updateUser(uid, {
      disabled: !active,
      email,
      photoURL: photoURL || undefined,
    });

    // Actualizar claims del usuario
    await admin.auth().setCustomUserClaims(uid, { 
      clientId,
      role,
      condominiumId: condominiumUids[0]
    });

    const userProfile = {
      uid,
      email,
      name,
      lastName,
      photoURL: photoURL || '',
      role,
      active,
      condominiumUids,
      updatedDate: admin.firestore.FieldValue.serverTimestamp(),
    };

    await Promise.all(
      condominiumUids.map(async (condominiumUid) => {
        const userProfileRef = admin
          .firestore()
          .collection(`clients/${clientId}/condominiums/${condominiumUid}/users`)
          .doc(uid);
        await userProfileRef.set(userProfile, { merge: true });
      }),
    );

    return userProfile;
  } catch (error) {
    console.error('Error al editar el usuario', error);
    if (error instanceof BadRequestException) {
      throw error;
    }
    if (error instanceof NotFoundException) {
      throw error;
    }

    if (error?.code === 'auth/user-not-found') {
      throw new NotFoundException('El usuario no existe en Firebase Auth.');
    }
    if (error?.code === 'auth/email-already-exists') {
      throw new BadRequestException(
        'El correo electrónico ya está en uso por otra cuenta.',
      );
    }
    if (error?.code === 'auth/invalid-email') {
      throw new BadRequestException('El correo electrónico no es válido.');
    }

    throw new InternalServerErrorException('Error al editar el usuario. Intente más tarde');
  }
}; 
