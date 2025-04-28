import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { onRequest } from 'firebase-functions/v2/https';
import { PublicationsService } from './publications.service';
import * as admin from 'firebase-admin';
import { CloudTasksClient, protos } from '@google-cloud/tasks';

// Cliente para Cloud Tasks
const tasksClient = new CloudTasksClient();
const PROJECT_ID =
  process.env.GOOGLE_CLOUD_PROJECT || 'administracioncondominio-93419';
const QUEUE_NAME = 'emailQueue';
const LOCATION = 'us-central1';
const publicationEmailUrl = `https://${LOCATION}-${PROJECT_ID}.cloudfunctions.net/processPublicationEmail`;

/**
 * Función Cloud que se activa cuando se crea una nueva publicación en un condominio
 * Crea tareas para enviar correos a los usuarios seleccionados
 */
export const onPublicationCreated = onDocumentCreated(
  'clients/{clientId}/condominiums/{condominiumId}/publications/{publicationId}',
  async (event: any) => {
    try {
      const snapshot = event.data;
      if (!snapshot) {
        console.log('No hay datos asociados al evento');
        return null;
      }

      const publicationData = snapshot.data();
      const { clientId, condominiumId, publicationId } = event.params;

      // Obtener todos los usuarios del condominio
      const usersRef = admin
        .firestore()
        .collection(`clients/${clientId}/condominiums/${condominiumId}/users`);

      const usersSnapshot = await usersRef.get();
      const tasksCreated: string[] = [];

      // Iterar sobre cada usuario para verificar si debe recibir la notificación
      for (const userDoc of usersSnapshot.docs) {
        const userData = userDoc.data();

        // Determinar si el correo debe enviarse al usuario según el campo sendTo
        let shouldSendEmail = false;

        if (publicationData.sendTo === 'todos') {
          // Si es para todos, verificar preferencias de notificación
          shouldSendEmail = true;
        } else if (Array.isArray(publicationData.sendTo)) {
          // Si es una lista de nombres completos, verificar si el usuario está incluido
          const fullName = `${userData.name} ${userData.lastName}`;
          shouldSendEmail = publicationData.sendTo.includes(fullName);
        } else {
          // Si es un rol específico, verificar si el usuario tiene ese rol
          shouldSendEmail = publicationData.sendTo === userData.role;
        }

        if (userData.email && shouldSendEmail) {
          try {
            // Crear tarea para enviar correo con un retraso aleatorio para distribuir la carga
            const parent = tasksClient.queuePath(
              PROJECT_ID,
              LOCATION,
              QUEUE_NAME,
            );
            const task: protos.google.cloud.tasks.v2.ITask = {
              httpRequest: {
                httpMethod: 'POST' as const,
                url: publicationEmailUrl,
                headers: { 'Content-Type': 'application/json' },
                body: Buffer.from(
                  JSON.stringify({
                    clientId,
                    condominiumId,
                    publicationId,
                    userId: userDoc.id,
                    email: userData.email,
                  }),
                ).toString('base64'),
              },
              scheduleTime: {
                seconds:
                  Math.floor(Date.now() / 1000) +
                  Math.floor(Math.random() * 10) +
                  1, // 1-10 segundos de retraso aleatorio
              },
            };

            await tasksClient.createTask({ parent, task });
            tasksCreated.push(userData.email);
          } catch (taskError) {
            console.error(
              `Error al crear tarea para ${userData.email}:`,
              taskError,
            );
          }
        }
      }

      console.log(
        `Creadas ${tasksCreated.length} tareas para enviar correos de publicación`,
      );
      return { success: true, tasksCreated: tasksCreated.length };
    } catch (error) {
      console.error('Error al procesar la publicación:', error);
      return { success: false, error };
    }
  },
);

/**
 * Función HTTP que procesa cada tarea de envío de correo
 */
export const processPublicationEmail = onRequest(async (req: any, res: any) => {
  try {
    const { clientId, condominiumId, publicationId, userId, email } = req.body;

    // Obtener datos de la publicación
    const publicationDoc = await admin
      .firestore()
      .doc(
        `clients/${clientId}/condominiums/${condominiumId}/publications/${publicationId}`,
      )
      .get();

    if (!publicationDoc.exists) {
      console.log('No se encontró la publicación');
      return res.status(404).send('Publicación no encontrada');
    }

    const publicationData = publicationDoc.data();

    // Instanciar el servicio
    const publicationsService = new PublicationsService();

    // Verificar preferencias de usuario
    const { wantsEmailNotifications, userData } =
      await publicationsService.checkUserNotificationPreference(
        clientId,
        condominiumId,
        userId,
        email,
      );

    if (!userData) {
      console.log(`No se encontró el usuario con email: ${email}`);
      return res.status(404).send('Usuario no encontrado');
    }

    if (!wantsEmailNotifications) {
      console.log(
        `El usuario ${userData.name} ha desactivado las notificaciones por email`,
      );
      return res.status(200).send('Usuario ha desactivado notificaciones');
    }

    // Enviar email
    const result = await publicationsService.sendEmailNotification(
      email,
      userData,
      publicationData,
    );

    if (result) {
      console.log(`Correo enviado exitosamente a ${email}`);
      return res.status(200).send('Correo enviado exitosamente');
    } else {
      console.error(`Error al enviar correo a ${email}`);
      return res.status(500).send('Error al enviar correo');
    }
  } catch (error) {
    console.error('Error al procesar la tarea de email:', error);
    return res.status(500).send('Error al procesar el envío de correo');
  }
});
