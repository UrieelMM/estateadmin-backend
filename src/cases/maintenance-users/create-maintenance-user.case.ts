import * as admin from 'firebase-admin';
import { 
  ConflictException, 
  InternalServerErrorException,
  Logger 
} from '@nestjs/common';
import { CreateMaintenanceUserDto } from '../../dtos/maintenance-user.dto';
import { v4 as uuidv4 } from 'uuid';

const logger = new Logger('CreateMaintenanceUserCase');

export const CreateMaintenanceUserCase = async (
  createMaintenanceUserDto: CreateMaintenanceUserDto,
  photoFile?: Express.Multer.File
) => {
  const {
    email,
    password,
    clientId,
    name,
    phone,
    company,
    responsibleName,
    responsiblePhone,
    emergencyNumber,
    assignedCondominiums,
  } = createMaintenanceUserDto;

  try {
    const userId = uuidv4();

    // 1. Crear usuario en Firebase Auth
    logger.log(`Creando usuario de mantenimiento en Auth: ${email}`);
    await admin.auth().createUser({
      uid: userId,
      email,
      password,
    });

    // 2. Asignar custom claims
    await admin.auth().setCustomUserClaims(userId, {
      clientId,
      role: 'maintenance',
    });

    // 3. Subir foto a Storage si existe
    let photoURL = '';
    if (photoFile) {
      try {
        logger.log(`Subiendo foto de perfil para usuario: ${userId}`);
        const bucket = admin.storage().bucket('administracioncondominio-93419.appspot.com');
        const fileExtension = photoFile.originalname.split('.').pop();
        const fileName = `${userId}_${Date.now()}.${fileExtension}`;
        const filePath = `clients/${clientId}/maintenanceAppUsers/${userId}/${fileName}`;
        const blob = bucket.file(filePath);

        await new Promise((resolve, reject) => {
          const blobStream = blob.createWriteStream({
            metadata: { contentType: photoFile.mimetype },
            resumable: false,
          });

          blobStream.on('error', (error) => {
            logger.error(`Error al subir foto: ${error.message}`);
            reject(error);
          });

          blobStream.on('finish', async () => {
            try {
              await blob.setMetadata({
                acl: [{ entity: 'allUsers', role: 'READER' }],
              });
              photoURL = `https://storage.googleapis.com/${bucket.name}/${blob.name}`;
              logger.log(`Foto subida exitosamente: ${photoURL}`);
              resolve(photoURL);
            } catch (err) {
              reject(err);
            }
          });

          blobStream.end(photoFile.buffer);
        });
      } catch (error) {
        logger.error(`Error al subir foto, continuando sin foto: ${error.message}`);
        // Continuamos sin foto si hay error
      }
    }

    // 4. Guardar perfil del usuario en Firestore
    logger.log(`Guardando perfil de usuario de mantenimiento en Firestore: ${userId}`);
    const userProfileRef = admin
      .firestore()
      .collection(`clients/${clientId}/maintenanceAppUsers`)
      .doc(userId);

    const userProfile = {
      id: userId,
      uid: userId,
      email,
      name,
      phone,
      company,
      responsibleName,
      responsiblePhone,
      emergencyNumber,
      assignedCondominiums,
      photoURL,
      role: 'maintenance',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await userProfileRef.set(userProfile);

    logger.log(`Usuario de mantenimiento creado exitosamente: ${userId}`);
    return {
      success: true,
      user: {
        ...userProfile,
        id: userId,
      },
    };
  } catch (error) {
    logger.error(`Error al crear usuario de mantenimiento: ${error.message}`);
    
    if (error.code === 'auth/email-already-exists') {
      throw new ConflictException('El correo electrónico ya está registrado.');
    } else {
      console.error('Error al crear usuario de mantenimiento', error);
      throw new InternalServerErrorException(
        'Error al crear usuario de mantenimiento. Intente más tarde'
      );
    }
  }
};
