import { onRequest } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
const cors = require('cors');

// Configuración del rate limiting: 10 requests por minuto
const RATE_LIMIT = 10;
const WINDOW_DURATION = 60 * 1000; // 1 minuto en milisegundos

// Función auxiliar para obtener la IP del cliente
function getClientIP(req: any): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    // x-forwarded-for puede contener una lista separada por comas
    return forwarded.split(/, /)[0];
  }
  return req.connection?.remoteAddress || 'unknown';
}

const corsHandler = cors({ origin: true });

export const rateLimitedGetQRData = onRequest(async (req, res) => {
  return corsHandler(req, res, async () => {
    try {
      // 1. Rate limiting por IP
      const clientIP = getClientIP(req);
      const rateLimitDocRef = admin
        .firestore()
        .collection('rateLimits')
        .doc(clientIP);
      const rateLimitDoc = await rateLimitDocRef.get();

      let count = 0;
      let windowStart = Date.now();

      if (rateLimitDoc.exists) {
        const data = rateLimitDoc.data();
        windowStart = data?.windowStart || Date.now();
        count = data?.count || 0;
      }

      const now = Date.now();
      // Si el periodo actual ha expirado, reiniciamos el contador y la ventana
      if (now - windowStart > WINDOW_DURATION) {
        count = 0;
        windowStart = now;
      }

      // Si se supera el límite, respondemos con 429 Too Many Requests
      if (count >= RATE_LIMIT) {
        res.status(429).send('Too Many Requests');
        return;
      }

      // Actualizamos el contador para la IP
      await rateLimitDocRef.set(
        { count: count + 1, windowStart },
        { merge: true },
      );

      // 2. Procesamos la solicitud del QR
      const qrId = req.query.qrId;
      if (!qrId || typeof qrId !== 'string') {
        res.status(400).send('Missing or invalid qrId parameter');
        return;
      }

      // Realizamos una consulta en cualquier subcolección "publicQRs" (collection group)
      const qrQuery = admin
        .firestore()
        .collectionGroup('publicQRs')
        .where('qrId', '==', qrId);
      const snapshot = await qrQuery.get();
      if (snapshot.empty) {
        res.status(404).send('QR not found');
        return;
      }

      const qrDoc = snapshot.docs[0];
      const qrData = qrDoc.data();

      // Verificamos la fecha de expiración del QR (suponiendo que se guarda en expiresAt como Timestamp)
      if (qrData.expiresAt && typeof qrData.expiresAt.toMillis === 'function') {
        if (qrData.expiresAt.toMillis() < now) {
          res.status(400).send('QR has expired');
          return;
        }
      }

      // Responder con los pagos (u otros datos que desees retornar)
      res.status(200).json(qrData.payments);
    } catch (error: any) {
      console.error('Error in rateLimitedGetQRData:', error);
      res.status(500).send('Internal Server Error');
    }
  });
});
