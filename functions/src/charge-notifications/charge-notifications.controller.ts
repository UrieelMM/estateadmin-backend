import * as admin from 'firebase-admin';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { onRequest } from 'firebase-functions/v2/https';
import { CloudTasksClient, protos } from '@google-cloud/tasks';
import { ChargeNotificationService } from './charge-notifications.service';

const tasksClient = new CloudTasksClient();
const PROJECT_ID =
  process.env.GOOGLE_CLOUD_PROJECT || 'administracioncondominio-93419';
const QUEUE_NAME = 'emailQueue';
const LOCATION = 'us-central1';
// URL pública de la función HTTP que procesará la tarea
const serviceUrl = `https://${LOCATION}-${PROJECT_ID}.cloudfunctions.net/sendChargeEmail`;

const chargeNotificationService = new ChargeNotificationService();

/**
 * Función que se activa cuando se crea un nuevo cargo
 * Detecta si el cargo ya fue notificado, y si no, programa una tarea para enviar la notificación
 */
export const onChargeCreated = onDocumentCreated(
  'clients/{clientId}/condominiums/{condominiumId}/users/{userId}/charges/{chargeId}',
  async (event) => {
    // Verificar si hay snapshot válido
    const snapshot = event.data;
    if (!snapshot) {
      console.log('No hay datos en el evento');
      return;
    }

    // Obtener datos del cargo
    const chargeData = snapshot.data();

    // Verificar si ya se envió la notificación
    if (chargeData.notificationSent === true) {
      console.log('La notificación ya ha sido enviada para este cargo');
      return;
    }

    // Extraer IDs desde el path
    // Ruta: clients/{clientId}/condominiums/{condominiumId}/users/{userId}/charges/{chargeId}
    const docPath = snapshot.ref.path;
    const pathSegments = docPath.split('/');
    const clientId = pathSegments[1];
    const condominiumId = pathSegments[3];
    const userId = pathSegments[5];
    const chargeId = pathSegments[7];

    // Actualizar el documento para indicar que la notificación ha sido programada
    try {
      await snapshot.ref.update({ notificationSent: true });
      console.log(`Documento actualizado: notificationSent = true`);
    } catch (error) {
      console.error('Error al actualizar el documento:', error);
      // Continuamos con el proceso aunque falle la actualización
    }

    // Crear una tarea para procesar el envío de correo con un retraso de 5 segundos
    const parent = tasksClient.queuePath(PROJECT_ID, LOCATION, QUEUE_NAME);
    const task: protos.google.cloud.tasks.v2.ITask = {
      httpRequest: {
        httpMethod: 'POST',
        url: serviceUrl,
        headers: { 'Content-Type': 'application/json' },
        body: Buffer.from(
          JSON.stringify({
            clientId,
            condominiumId,
            userId,
            chargeId,
            email: chargeData.email, // Asumimos que el email está en los datos del cargo
          }),
        ).toString('base64'),
      },
      scheduleTime: {
        seconds: Date.now() / 1000 + 5, // 5 segundos de retraso
      },
    };

    try {
      const [response] = await tasksClient.createTask({ parent, task });
      console.log(`Tarea creada: ${response.name}`);
    } catch (error) {
      console.error('Error al crear la tarea:', error);
    }
  },
);

/**
 * Endpoint HTTP que procesa la tarea y envía el correo electrónico
 */
export const sendChargeEmail = onRequest(async (req, res) => {
  try {
    const { clientId, condominiumId, userId, chargeId, email } = req.body;

    if (!clientId || !condominiumId || !userId || !chargeId || !email) {
      res.status(400).send('Faltan parámetros obligatorios');
      return;
    }

    // Obtener los datos completos del cargo desde Firestore
    const chargeRef = admin
      .firestore()
      .doc(
        `clients/${clientId}/condominiums/${condominiumId}/users/${userId}/charges/${chargeId}`,
      );
    const chargeDoc = await chargeRef.get();

    if (!chargeDoc.exists) {
      res.status(404).send('No se encontró el cargo especificado');
      return;
    }

    const chargeData = chargeDoc.data();

    // Obtener datos del usuario
    const userRef = admin
      .firestore()
      .doc(`clients/${clientId}/condominiums/${condominiumId}/users/${userId}`);
    const userDoc = await userRef.get();
    const userData = userDoc.exists ? userDoc.data() : { name: 'Residente' };

    // Enviar correo electrónico
    await chargeNotificationService.sendChargeNotificationEmail(
      email,
      // Ensure userData is defined before accessing properties
      userData?.name || 'Residente',
      chargeData,
      clientId,
      condominiumId,
      userId,
    );

    res.status(200).send('Correo enviado correctamente');
  } catch (error) {
    console.error('Error al procesar la solicitud:', error);
    res.status(500).send('Error al procesar la solicitud');
  }
});
