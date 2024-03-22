import { InternalServerErrorException } from '@nestjs/common';
import * as admin from 'firebase-admin';
import { v4 as uuidv4 } from 'uuid';
import { format } from 'date-fns';
import { CreatePublicationDto } from 'src/dtos';

export const CreatePublicationCase = async (
  createPublicationDto: CreatePublicationDto,
  files: Express.Multer.File[],
) => {
  const {
    clientId,
    title,
    content,
    author,
    tags,
    condominiumName,
    condominiumId, // Usamos condominiumId como base para organizar las publicaciones
    sendTo
  } = createPublicationDto;

  console.log(clientId);

  if (!condominiumId || !clientId) {
    throw new InternalServerErrorException('No se ha proporcionado un condominiumId o clientId válido.');
  }

  const publicationId = uuidv4();
  const datePath = format(new Date(), 'yyyy-MM-dd');
  const bucket = admin.storage().bucket("administracioncondominio-93419.appspot.com");

  // Ajustar la ruta de subida de archivos para incluir condominiumId
  const uploadPromises = files.map((file) => {
    const fileUploadPath = `clients/${clientId}/condominiums/${condominiumId}/publications/${datePath}/${file.originalname}`;
    const blob = bucket.file(fileUploadPath);

    return new Promise((resolve, reject) => {
      const blobStream = blob.createWriteStream({
        metadata: {
          contentType: file.mimetype,
        },
      });

      blobStream.on('error', reject);

      blobStream.on('finish', async () => {
        const publicUrl = `https://storage.googleapis.com/${bucket.name}/${blob.name}`;
        resolve(publicUrl);
      });

      blobStream.end(file.buffer);
    });
  });

  try {
    const attachmentUrls = await Promise.all(uploadPromises);

    const publicationData = {
      publicationId,
      clientId,
      author,
      title,
      content,
      tags,
      sendTo,
      condominiumName,
      attachmentPublications: attachmentUrls,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    // Ajustar el camino en Firestore para incluir condominiumId
    await admin.firestore()
      .collection('clients')
      .doc(clientId)
      .collection('condominiums')
      .doc(condominiumId)
      .collection('publications')
      .doc(publicationId)
      .set(publicationData);

    return { publicationId, attachmentUrls };
  } catch (error) {
    console.error('Error al crear la publicación:', error);
    throw new InternalServerErrorException('Error al crear la publicación. Intente más tarde.');
  }
};
