import { onRequest } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
const cors = require('cors');
const { MailerSend, EmailParams, Recipient, Sender } = require('mailersend');

const corsHandler = cors({ origin: true });

export const sendNotificationMorosidad = onRequest(
  async (req: any, res: any) => {
    return corsHandler(req, res, async () => {
      try {
        const { clientId, condominiumId, userUID } = req.body;

        // Obtener datos del usuario
        const userDoc = await admin
          .firestore()
          .doc(
            `clients/${clientId}/condominiums/${condominiumId}/users/${userUID}`,
          )
          .get();

        if (!userDoc.exists) {
          console.error('No se encontró el usuario');
          return res.status(404).send('Usuario no encontrado');
        }

        const userData = userDoc.data();

        // Obtener cargos pendientes
        const chargesSnapshot = await admin
          .firestore()
          .collection(
            `clients/${clientId}/condominiums/${condominiumId}/users/${userUID}/charges`,
          )
          .where('paid', '==', false)
          .get();

        if (chargesSnapshot.empty) {
          console.log('No hay cargos pendientes');
          return res.status(404).send('No hay cargos pendientes');
        }

        // Mapear los meses a nombres en español
        const monthNames = [
          'Enero',
          'Febrero',
          'Marzo',
          'Abril',
          'Mayo',
          'Junio',
          'Julio',
          'Agosto',
          'Septiembre',
          'Octubre',
          'Noviembre',
          'Diciembre',
        ];

        // Generar HTML para la tabla de cargos
        let chargesDetailsHtml = '';
        let totalAmount = 0;

        chargesSnapshot.docs.forEach((doc) => {
          const charge = doc.data();
          const startAt = charge.startAt ? charge.startAt.split(' ')[0] : ''; // Obtener solo la fecha
          const month = startAt ? new Date(startAt).getMonth() : -1;
          const monthName =
            month >= 0 ? monthNames[month] : 'Mes no especificado';
          const amount = charge.amount || 0;
          totalAmount += amount;

          chargesDetailsHtml += `
          <tr style="border-bottom:1px solid #ddd;">
            <td style="padding:8px; text-align:left;">${charge.concept || 'Sin concepto'}</td>
            <td style="padding:8px; text-align:center;">${monthName}</td>
            <td style="padding:8px; text-align:right;">$${(amount / 100).toFixed(2)}</td>
          </tr>
        `;
        });

        const totalsRow = `
        <tr style="font-weight:bold; border-top:2px solid #6366F1;">
          <td style="padding:8px; text-align:left;">Total:</td>
          <td style="padding:8px; text-align:center;"></td>
          <td style="padding:8px; text-align:right;">$${(totalAmount / 100).toFixed(2)}</td>
        </tr>
      `;

        const emailHtml = `
        <html>
            <head>
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
              <style>
                body { font-family: 'Open Sans', sans-serif; margin:0; padding:0; background-color: #f6f6f6; }
                .container { width: 90%; max-width: 600px; margin: 40px auto; background-color: #ffffff; border-radius: 10px; padding: 20px; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1); }
                .header { background-color: #6366F1; padding: 20px; border-radius: 10px 10px 0 0; text-align: center; }
                .header img { width: 100px; height: auto; }
                .header h1 { color: #ffffff; margin: 0; font-size: 24px; }
                .content { padding: 20px; }
                .details-table { width: 100%; border-collapse: collapse; }
                .details-table th, .details-table td { padding:8px; border-bottom: 1px solid #ddd; text-align: left; }
                .details-table th { background-color: #6366F1; color: #ffffff; text-align: left; }
                .details-table tr:nth-child(odd) { background-color: #f9f9f9; }
                .totals { font-weight: bold; }
                .button { background-color: #6366F1; color: #ffffff; text-decoration: none; padding: 15px; display: block; text-align: center; border-radius: 5px; margin: 20px 0; }
                .footer { text-align: center; font-size: 14px; color: #666666; margin-top: 20px; }
                @media (max-width: 600px) {
                  .header h1 { font-size: 20px; }
                  .details-table th, .details-table td { font-size: 12px; padding: 5px; }
                  .button { padding: 10px; font-size: 16px; }
                  .container { padding: 10px; }
                }
              </style>
              <link rel="preconnect" href="https://fonts.googleapis.com">
              <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
              <link href="https://fonts.googleapis.com/css2?family=Open+Sans:ital,wght@0,300;0,400;0,600;0,700;0,800&display=swap" rel="stylesheet">
            </head>
            <body>
              <div class="container">
                <div class="header">
                  <img src="https://firebasestorage.googleapis.com/v0/b/iahub-24.appspot.com/o/app%2Fassets%2Flogo%2F2.png?alt=media&token=5fb84508-cad4-405c-af43-cd1a4f54f521" alt="EstateAdmin">
                  <h1>Notificación de Pagos Pendientes</h1>
                </div>
                <div class="content" style="padding:20px; background-color: #f6f6f6; margin-top:20px; border-radius: 10px;">
                  <h2 style="color:#1a1a1a; font-size:20px;">Hola, ${userData?.name || 'Residente'}</h2>
                  <p style="color:#1a1a1a; font-size:16px;">Te notificamos que tienes los siguientes cargos pendientes:</p>
                  <table class="details-table">
                    <tr>
                      <th>Concepto</th>
                      <th>Mes</th>
                      <th>Monto</th>
                    </tr>
                    ${chargesDetailsHtml}
                    ${totalsRow}
                  </table>
                  <table style="width:100%;">
                    <tr>
                      <td>
                        <p style="font-size:12px;color:#ffffff;margin-top:20px; font-weight:bold; background-color: #6366F1;border-radius:10px;padding:20px;text-align:center">
                          Por favor, realiza tus pagos pendientes para mantener tu cuenta al corriente.
                        </p>
                      </td>
                    </tr>
                  </table>
                </div>
                <div class="footer">
                  <div class="footer" style="background-color:#f6f6f6;border-radius:10px 10px 0 0;padding:10px;text-align:center; color:#1a1a1a">
                    <p>Modernidad y Eficacia en la Administración</p>
                    <p>Síguenos en nuestras redes sociales: 
                      <a href="URL_FACEBOOK" style="color:#6366F1; text-decoration:none;">Facebook</a> | 
                      <a href="URL_TWITTER" style="color:#6366F1; text-decoration:none;">Twitter</a> | 
                      <a href="URL_INSTAGRAM" style="color:#6366F1; text-decoration:none;">Instagram</a>
                    </p>
                    <p>Omnipixel</p>
                  </div>
                </div>
              </div>
            </body>
          </html>
      `;

        // Enviar correo
        const mailerSend = new MailerSend({
          apiKey:
            'mlsn.3611aa51c08f244faf71131ceb627e193d3f57183323b0cb39538532bd6abfa7',
        });

        const emailParams = new EmailParams()
          .setFrom(
            new Sender(
              'MS_Fpa0aS@notifications.estate-admin.com',
              'EstateAdmin Notifications',
            ),
          )
          .setTo([
            new Recipient(userData?.email || '', userData?.name || 'Residente'),
          ])
          .setReplyTo(
            new Sender(
              'MS_Fpa0aS@notifications.estate-admin.com',
              'EstateAdmin Notifications',
            ),
          )
          .setSubject('Notificación de Pagos Pendientes')
          .setHtml(emailHtml);

        await mailerSend.email.send(emailParams);
        console.log(`Correo enviado exitosamente a ${userData?.email}`);

        res.status(200).send('Correo enviado exitosamente');
      } catch (error) {
        console.error('Error al enviar el correo de notificación:', error);
        res.status(500).send('Error al procesar el envío de correo');
      }
    });
  },
);
