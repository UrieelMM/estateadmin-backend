import * as admin from 'firebase-admin';
import { 
  NotFoundException,
  InternalServerErrorException,
  Logger 
} from '@nestjs/common';
import { UpdateMaintenanceUserDto } from '../../dtos/maintenance-user.dto';

const logger = new Logger('UpdateMaintenanceUserCase');

export const UpdateMaintenanceUserCase = async (
  updateMaintenanceUserDto: UpdateMaintenanceUserDto,
  photoFile?: Express.Multer.File
) => {
  const {
    userId,
    clientId,
    name,
    phone,
    company,
    responsibleName,
    responsiblePhone,
    emergencyNumber,
    assignedCondominiums,
  } = updateMaintenanceUserDto;

  try {
    // 1. Verificar que el usuario existe en Firestore
    logger.log(`Actualizando usuario de mantenimiento: ${userId}`);
    const userProfileRef = admin
      .firestore()
      .collection(`clients/${clientId}/maintenanceAppUsers`)
      .doc(userId);

    const userDoc = await userProfileRef.get();
    if (!userDoc.exists) {
      throw new NotFoundException('Usuario de mantenimiento no encontrado');
    }

    const currentData = userDoc.data();
    let photoURL = currentData.photoURL || '';

    // 2. Subir nueva foto a Storage si existe
    if (photoFile) {
      try {
        logger.log(`Subiendo nueva foto de perfil para usuario: ${userId}`);
        const bucket = admin.storage().bucket('administracioncondominio-93419.appspot.com');
        
        // Eliminar foto anterior si existe
        if (photoURL) {
          try {
            const oldFileName = photoURL.split('/').pop();
            const oldFilePath = `clients/${clientId}/maintenanceAppUsers/${userId}/${oldFileName}`;
            const oldBlob = bucket.file(oldFilePath);
            const [exists] = await oldBlob.exists();
            if (exists) {
              await oldBlob.delete();
              logger.log(`Foto anterior eliminada: ${oldFilePath}`);
            }
          } catch (deleteError) {
            logger.warn(`No se pudo eliminar la foto anterior: ${deleteError.message}`);
          }
        }

        // Subir nueva foto
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
              logger.log(`Nueva foto subida exitosamente: ${photoURL}`);
              resolve(photoURL);
            } catch (err) {
              reject(err);
            }
          });

          blobStream.end(photoFile.buffer);
        });
      } catch (error) {
        logger.error(`Error al subir nueva foto: ${error.message}`);
        // Continuamos con la foto anterior si hay error
      }
    }

    // 3. Actualizar perfil del usuario en Firestore
    logger.log(`Actualizando perfil en Firestore: ${userId}`);
    const updateData: any = {
      name,
      phone,
      company,
      responsibleName,
      responsiblePhone,
      emergencyNumber,
      assignedCondominiums,
    };

    // Solo actualizar photoURL si se subió una nueva foto
    if (photoFile && photoURL) {
      updateData.photoURL = photoURL;
    }

    await userProfileRef.update(updateData);

    logger.log(`Usuario de mantenimiento actualizado exitosamente: ${userId}`);
    
    // Obtener datos actualizados
    const updatedDoc = await userProfileRef.get();
    const updatedData = updatedDoc.data();

    return {
      success: true,
      user: {
        id: userId,
        ...updatedData,
      },
    };
  } catch (error) {
    logger.error(`Error al actualizar usuario de mantenimiento: ${error.message}`);
    
    if (error instanceof NotFoundException) {
      throw error;
    } else {
      console.error('Error al actualizar usuario de mantenimiento', error);
      throw new InternalServerErrorException(
        'Error al actualizar usuario de mantenimiento. Intente más tarde'
      );
    }
  }
};
