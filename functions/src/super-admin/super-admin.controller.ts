import * as admin from 'firebase-admin';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import * as crypto from 'crypto';

// Función para generar un token de sesión seguro
const generateSessionToken = (uid: string) => {
  const sessionKey = process.env.SESSION_SECRET_KEY || 'default-session-key';
  const timestamp = Date.now();
  const randomToken = crypto.randomBytes(32).toString('hex');
  const hmac = crypto.createHmac('sha256', sessionKey);
  hmac.update(`${uid}-${timestamp}-${randomToken}`);
  return hmac.digest('hex');
};

// Verificación de Super Admin
export const verifySuperAdminAccess = onCall(
  {
    cors: [
      'http://localhost:5173',
      'http://localhost:5174',
      'https://estate-admin.com',
      'https://admin.estate-admin.com',
    ], // Dominios permitidos
    maxInstances: 10,
  },
  async (request) => {
    // Verificar autenticación
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Usuario no autenticado');
    }

    try {
      const { ip, userAgent } = request.data || {};
      const uid = request.auth.uid;
      const userRecord = await admin.auth().getUser(uid);

      // Verificar rol del usuario
      const customClaims = userRecord.customClaims || {};
      if (customClaims.role !== 'super-provider-admin') {
        // Verificar también en Firestore
        const userDoc = await admin
          .firestore()
          .collection('administration/users/users')
          .doc(uid)
          .get();

        if (
          !userDoc.exists ||
          userDoc.data()?.role !== 'super-provider-admin'
        ) {
          // Registrar intento no autorizado
          await admin
            .firestore()
            .collection('security_logs')
            .add({
              userId: uid,
              email: userRecord.email,
              action: 'unauthorized_super_admin_access',
              timestamp: admin.firestore.FieldValue.serverTimestamp(),
              ip: ip || 'unknown',
              userAgent: userAgent || 'unknown',
            });

          throw new HttpsError(
            'permission-denied',
            'No tienes permisos suficientes',
          );
        }
      }

      // Generar token de sesión
      const sessionToken = generateSessionToken(uid);
      const expiryTime = Date.now() + 60 * 60 * 1000; // 1 hora

      // Guardar sesión en Firestore
      await admin
        .firestore()
        .collection('administration/users/superAdminSessions')
        .add({
          userId: uid,
          email: userRecord.email,
          sessionToken: sessionToken,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          expiresAt: admin.firestore.Timestamp.fromMillis(expiryTime),
          ip: ip || 'unknown',
          userAgent: userAgent || 'unknown',
        });

      return {
        sessionToken,
        expiresAt: expiryTime,
      };
    } catch (error) {
      console.error('Error en verificación de Super Admin:', error);
      throw new HttpsError(
        'internal',
        'Error al verificar el acceso de Super Admin',
      );
    }
  },
);

// Verificar validez de sesión Super Admin
export const validateSuperAdminSession = onCall(
  {
    cors: [
      'http://localhost:5173',
      'https://estate-admin.com',
      'https://admin.estate-admin.com',
    ], // Dominios permitidos
    maxInstances: 20,
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Usuario no autenticado');
    }

    try {
      const { sessionToken } = request.data || {};
      const uid = request.auth.uid;

      if (!sessionToken) {
        throw new HttpsError(
          'invalid-argument',
          'Token de sesión no proporcionado',
        );
      }

      // Buscar sesión activa
      const sessionsSnapshot = await admin
        .firestore()
        .collection('administration/users/superAdminSessions')
        .where('userId', '==', uid)
        .where('sessionToken', '==', sessionToken)
        .where('expiresAt', '>', admin.firestore.Timestamp.now())
        .limit(1)
        .get();

      if (sessionsSnapshot.empty) {
        throw new HttpsError('permission-denied', 'Sesión inválida o expirada');
      }

      // Extender la sesión por 1 hora más
      const sessionDoc = sessionsSnapshot.docs[0];
      const newExpiryTime = Date.now() + 60 * 60 * 1000;

      await sessionDoc.ref.update({
        expiresAt: admin.firestore.Timestamp.fromMillis(newExpiryTime),
        lastAccessed: admin.firestore.FieldValue.serverTimestamp(),
      });

      return {
        valid: true,
        expiresAt: newExpiryTime,
      };
    } catch (error) {
      console.error('Error al validar sesión:', error);
      throw new HttpsError('internal', 'Error al validar la sesión');
    }
  },
);

// Operación protegida para Super Admin (ejemplo para gestión de usuarios)
export const superAdminOperation = onCall(
  {
    cors: [
      'http://localhost:5173',
      'https://estate-admin.com',
      'https://admin.estate-admin.com',
    ],
    maxInstances: 10,
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Usuario no autenticado');
    }

    let auditRef;
    try {
      const { sessionToken, operation, targetId, payload } = request.data || {};
      const uid = request.auth.uid;

      // Verificar sesión válida
      const sessionsSnapshot = await admin
        .firestore()
        .collection('administration/users/superAdminSessions')
        .where('userId', '==', uid)
        .where('sessionToken', '==', sessionToken)
        .where('expiresAt', '>', admin.firestore.Timestamp.now())
        .limit(1)
        .get();

      if (sessionsSnapshot.empty) {
        throw new HttpsError('permission-denied', 'Sesión inválida o expirada');
      }

      // Verificar permisos del usuario
      const userRecord = await admin.auth().getUser(uid);
      const customClaims = userRecord.customClaims || {};

      if (customClaims.role !== 'super-provider-admin') {
        throw new HttpsError(
          'permission-denied',
          'No tienes permisos suficientes',
        );
      }

      // Registrar la operación
      auditRef = await admin
        .firestore()
        .collection('administration/users/superAdminAudit')
        .add({
          userId: uid,
          email: userRecord.email,
          operation,
          targetId,
          requestPayload: payload,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          status: 'pending',
        });

      // Ejecutar la operación solicitada
      let result;

      switch (operation) {
        case 'create_client':
          // Implementación para crear cliente
          result = { success: true, message: 'Cliente creado correctamente' };
          break;

        case 'update_client':
          if (!targetId || !payload) {
            throw new HttpsError(
              'invalid-argument',
              'Se requiere targetId y payload para actualizar cliente',
            );
          }

          // Verificar que el cliente existe
          const clientRef = admin
            .firestore()
            .collection('clients')
            .doc(targetId);
          const clientDoc = await clientRef.get();

          if (!clientDoc.exists) {
            throw new HttpsError('not-found', 'Cliente no encontrado');
          }

          // Actualizar el cliente
          await clientRef.update({
            ...payload,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedBy: uid,
          });

          result = {
            success: true,
            message: 'Cliente actualizado correctamente',
          };
          break;

        case 'delete_client':
          if (!targetId) {
            throw new HttpsError(
              'invalid-argument',
              'Se requiere targetId para eliminar cliente',
            );
          }

          // Verificar que el cliente existe
          const clientToDeleteRef = admin
            .firestore()
            .collection('clients')
            .doc(targetId);
          const clientToDeleteDoc = await clientToDeleteRef.get();

          if (!clientToDeleteDoc.exists) {
            throw new HttpsError('not-found', 'Cliente no encontrado');
          }

          // Eliminar el cliente
          await clientToDeleteRef.delete();

          result = {
            success: true,
            message: 'Cliente eliminado correctamente',
          };
          break;

        default:
          throw new HttpsError(
            'invalid-argument',
            `Operación no soportada: ${operation}`,
          );
      }

      // Actualizar registro de auditoría
      await auditRef.update({
        status: 'completed',
        result,
        completedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return result;
    } catch (error: any) {
      console.error('Error en operación de Super Admin:', error);

      // Si hay un error, actualizar el registro de auditoría
      if (auditRef) {
        await auditRef.update({
          status: 'failed',
          error: error.message,
          errorDetails: error.stack,
          completedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      // Propagar el mensaje de error original si existe
      throw new HttpsError(
        'internal',
        error.message || 'Error al procesar la operación',
      );
    }
  },
);
