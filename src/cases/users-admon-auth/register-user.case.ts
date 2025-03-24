import * as admin from 'firebase-admin';
import { RegisterUserDto } from '../../dtos/register-user.dto';
import { ConflictException, InternalServerErrorException } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';

export const registerUser = async (registerUserDto: RegisterUserDto) => {
  const { 
    email, 
    name, 
    lastName, 
    condominiumUids, 
    photoURL, 
    role,
    active,
    clientId,
    password 
  } = registerUserDto;

  try {
    const uid = uuidv4(); // Generamos el UID del usuario
    
    // Crea un nuevo usuario en Firebase Auth
    await admin.auth().createUser({
      uid,
      email,
      password, // Usamos la contraseña del DTO
    });

    // Asignar claims al usuario
    await admin.auth().setCustomUserClaims(uid, { 
      clientId,
      role,
      condominiumId: condominiumUids[0]
    });

    // Guardar el perfil del usuario en Firestore
    const userProfileRef = admin.firestore()
      .collection(`clients/${clientId}/condominiums/${condominiumUids[0]}/users`)
      .doc(uid);

    const userProfile = {
      uid,
      email,
      name,
      lastName,
      photoURL: photoURL || "",
      role,
      active: active ?? true,
      condominiumUids,
      createdDate: admin.firestore.FieldValue.serverTimestamp(),
    };

    await userProfileRef.set(userProfile);

    return userProfile;
  } catch (error) {
    if (error.code === 'auth/email-already-exists') {
      throw new ConflictException('El correo electrónico ya está registrado.');
    } else {
      console.error('Error al registrar el usuario', error);
      throw new InternalServerErrorException('Error al registrar el usuario. Intente más tarde');
    }
  }
};
