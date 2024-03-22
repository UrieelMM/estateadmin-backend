import * as admin from 'firebase-admin';
import { RegisterUserDto } from '../../dtos/register-user.dto';
import { ConflictException, InternalServerErrorException } from '@nestjs/common';

export const registerUser = async (registerUserDto: RegisterUserDto) => {
  const { email, password, name, lastName, condominiumUids, clientId } = registerUserDto;

  try {
    // Crea un nuevo usuario en Firebase Aut
    const userRecord = await admin.auth().createUser({
      email,
      password,
    });

    // Asigna los claims customizados al usuario. Solo incluimos clientId y role ya que condominiumUids se manejarán en Firestore.
    await admin.auth().setCustomUserClaims(userRecord.uid, { clientId: clientId, role: 'admin-assistant', condominiumId: condominiumUids[0]});

    // Aquí se opta por no usar condominiumUid directamente en los custom claims debido al potencial límite de tamaño.

    // Guarda el perfil del usuario en Firestore indicando los condominios a los que tiene acceso.
    const userProfileRef = admin.firestore().collection(`clients/${clientId}/condominiums/${condominiumUids[0]}/users`).doc(userRecord.uid);

    const userProfile = {
      uid: userRecord.uid,
      email,
      name,
      lastName,
      role: 'admin-assistant', // Rol por defecto
      condominiumUids, // Almacena el array de UIDs
      createdDate: admin.firestore.FieldValue.serverTimestamp(), // Fecha de creación
    };

    // Guarda el perfil del usuario en Firestore
    await userProfileRef.set(userProfile);

    return userProfile; // Retorna los detalles del perfil creado
  } catch (error) {
    if (error.code === 'auth/email-already-exists') {
      throw new ConflictException('El correo electrónico ya está registrado.');
    } else {
      console.error('Error al registrar el usuario', error);
      throw new InternalServerErrorException('Error al registrar el usuario. Intente más tarde');
    }
  }
};
