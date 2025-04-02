import * as admin from 'firebase-admin';
import { RegisterSuperAdminDto } from 'src/dtos/register-super-admin.dto';
import { HttpException, HttpStatus } from '@nestjs/common';

export const registerSuperAdmin = async (
  registerSuperAdminDto: RegisterSuperAdminDto,
) => {
  try {
    // Preparar los datos para crear el usuario
    const userCreateData: any = {
      email: registerSuperAdminDto.email,
      password: registerSuperAdminDto.password,
      displayName: `${registerSuperAdminDto.name} ${registerSuperAdminDto.lastName}`,
    };

    // Solo añadir photoURL si tiene un valor que sea una URL válida
    if (
      registerSuperAdminDto.photoURL &&
      registerSuperAdminDto.photoURL.trim() !== ''
    ) {
      // Verificar si es una URL válida
      try {
        new URL(registerSuperAdminDto.photoURL);
        userCreateData.photoURL = registerSuperAdminDto.photoURL;
      } catch (e) {
        // Si no es una URL válida, no incluir el campo
        console.log('photoURL proporcionado no es una URL válida, se omitirá.');
      }
    }

    // Crear el usuario en Firebase Auth
    const userRecord = await admin.auth().createUser(userCreateData);

    // Establecer los claims para el role
    await admin.auth().setCustomUserClaims(userRecord.uid, {
      role: 'super-provider-admin',
    });

    // Para Firestore, podemos guardar el photoURL como string vacío si no es válido
    const photoURLForFirestore = registerSuperAdminDto.photoURL || '';

    // Guardar en Firestore en la colección administration/users
    await admin
      .firestore()
      .collection('administration')
      .doc('users')
      .set(
        { lastUpdated: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true },
      )
      .then(async () => {
        await admin
          .firestore()
          .collection('administration/users/users')
          .doc(userRecord.uid)
          .set({
            name: registerSuperAdminDto.name,
            lastName: registerSuperAdminDto.lastName,
            email: registerSuperAdminDto.email,
            photoURL: photoURLForFirestore,
            active: true,
            dateRegister: admin.firestore.FieldValue.serverTimestamp(),
            UID: userRecord.uid,
            role: 'super-provider-admin',
          });
      });

    return {
      success: true,
      message: 'Super admin creado exitosamente',
      data: {
        uid: userRecord.uid,
        email: userRecord.email,
        name: registerSuperAdminDto.name,
        lastName: registerSuperAdminDto.lastName,
      },
    };
  } catch (error) {
    console.error('Error registrando super admin:', error);
    throw new HttpException(
      {
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        error: 'Error al registrar super admin',
        details: error.message,
      },
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }
};
