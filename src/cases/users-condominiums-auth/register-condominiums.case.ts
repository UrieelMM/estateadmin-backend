import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import * as admin from 'firebase-admin';
import { readExcel } from '../../utils/readExcel';
import * as XLSX from 'xlsx';
import { UserCondominiumDto } from 'src/dtos/register-user-condominium.dto';
import { EmailParams, Sender, Recipient } from 'mailersend';
import { mailerSend } from 'src/utils/mailerSend';

@Injectable()
export class RegisterCondominiumUsersCase {
  private readonly logger = new Logger(RegisterCondominiumUsersCase.name);

  async execute(fileBuffer: Buffer, clientId: string, condominiumId: string): Promise<void> {
    if (!clientId) {
      throw new BadRequestException('ClientId es requerido.');
    }
    if (!condominiumId) {
      throw new BadRequestException('CondominiumId es requerido.');
    }

    const usersData: UserCondominiumDto[] = readExcel(fileBuffer) as UserCondominiumDto[];

    if (usersData.length === 0) {
      throw new BadRequestException('El archivo Excel está vacío o no tiene el formato correcto.');
    }

    for (const userData of usersData) {
      try {
        // Registrar el documento en Firestore sin crear cuenta en Firebase Auth
        const profilePath = `clients/${clientId}/condominiums/${condominiumId}/users`;
        const docRef = admin.firestore().collection(profilePath).doc();
        const uid = docRef.id;

        await docRef.set({
          name: userData.name,
          email: userData.email,
          lastName: userData.lastName || '',
          phone: userData.phone || '',
          RFC: userData.RFC || '',
          CP: userData.CP || '',
          address: userData.address || '',
          city: userData.city || '',
          state: userData.state || '',
          country: userData.country || '',
          number: String(userData.number || ''),
          businessName: userData.businessName || '',
          taxResidence: userData.taxResidence || '',
          taxtRegime: userData.taxtRegime || '',
          photoURL: userData.photoURL || '',
          departament: userData.departament || '',
          uid: uid,
          role: userData.role || 'condominium',
        });

        this.logger.log(`Documento creado para usuario: email=${userData.email}, uid=${uid}`);

        // Preparar y enviar el correo electrónico
        const sentFrom = new Sender('MS_CUXpzj@estate-admin.com', 'EstateAdmin Support');
        const recipients = [new Recipient(userData.email || 'Sin email', userData.name || 'Sin nombre')];

        // Función para generar la plantilla HTML del correo sin contraseña
        const htmlTemplate = (data: UserCondominiumDto) => `
          <html>
            <head>
              <style>
                :root {
                  font-family: 'Open Sans', sans-serif;
                }
                .button {
                  background-color: #6366F1; 
                  color: white; 
                  padding: 20px; 
                  text-align: center; 
                  text-decoration: none; 
                  display: inline-block; 
                  border-radius: 5px;
                  margin-top: 20px;
                  font-size: 18px;
                  font-weight: bold;
                  width: 350px;
                }
                .footer-link {
                  color: #6366F1 !important;
                  text-decoration: none;
                }
              </style>
              <link rel="preconnect" href="https://fonts.googleapis.com">
              <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
              <link href="https://fonts.googleapis.com/css2?family=Open+Sans:ital,wght@0,300..800;1,300..800&display=swap" rel="stylesheet">
            </head>
            <body style="background-color: #f6f6f6;">
              <table width="50%" style="background-color: #ffffff; border-radius: 10px; padding: 50px 40px; margin: 40px auto 0 auto; box-shadow: 5px 5px 10px rgba(0, 0, 0, .1);" cellspacing="0" cellpadding="0">
                <tr>
                  <td style="background-color: #6366F1; border-radius: 5px 5px 0 0; padding: 10px 0 0 0; text-align: center;">
                    <img style="width: 140px; height: 140px; object-fit: contain;" src="https://firebasestorage.googleapis.com/v0/b/iahub-24.appspot.com/o/app%2Fassets%2Flogo%2F2.png?alt=media&token=5fb84508-cad4-405c-af43-cd1a4f54f521" alt="EstateAdmin">
                  </td>
                </tr>
                <tr>
                  <td style="background-color: #6366F1; border-radius: 0 0 5px 5px; padding: 0 0 20px 0; text-align: center;">
                    <h1 style="color: white; margin: 0; font-size: 24px;">Bienvenido a la comunidad EstateAdmin</h1>
                  </td>
                </tr>
                <tr>
                  <td style="padding: 20px 0; text-align: center;">
                    <table style="width: 100%; margin: 20px auto 0 auto; background-color: #f6f6f6; padding: 20px 10px; border-radius: 10px;">
                      <tr>
                        <td style="padding: 10px; text-align: center;">
                          <h2 style="color: #6366F1; font-size: 20px; margin-bottom: 0;">Hola, ${data.name}. Has sido registrado en EstateAdmin</h2>
                        </td>
                      </tr>
                      <tr>
                        <td style="padding: 30px 10px; font-size: 15px;" width="200">
                          A partir de ahora comenzarás a ser notificado de las actividades de tu condominio y recibir confirmaciones de pagos y notificaciones de eventos importantes, por correo electrónico y WhatsApp si así lo deseas.
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
                <tr>
                  <td style="background-color: #f6f6f6; border-radius: 10px 10px 0 0; padding: 10px; text-align: center;">
                    <img style="width: 100px; height: 100px; object-fit: contain;" src="https://firebasestorage.googleapis.com/v0/b/iahub-24.appspot.com/o/app%2Fassets%2Flogo%2FLogo_omnipixel_2.png?alt=media&token=b71109fb-4489-40ee-a603-17dc40a1fb46" alt="Omnipixel">
                    <p style="font-weight: bold; font-size: 16px; margin: 0;">Modernidad y Eficacia en la Administración</p>
                  </td>
                </tr>
                <tr>
                  <td style="background-color: #f6f6f6; border-radius: 0 0 10px 10px; padding: 10px; text-align: center;">
                    <p style="font-weight: bold; font-size: 14px;">Síguenos en nuestras redes sociales:</p>
                    <p>
                      <a href="URL_FACEBOOK" class="footer-link">Facebook</a> | 
                      <a href="URL_TWITTER" class="footer-link">Twitter</a> | 
                      <a href="URL_INSTAGRAM" class="footer-link">Instagram</a>
                    </p>
                    <p>Un servicio de Omnipixel</p>
                  </td>
                </tr>
              </table>
            </body>
          </html>
        `;

        const emailHtml = htmlTemplate(userData);

        const emailParams = new EmailParams()
          .setFrom(sentFrom)
          .setTo(recipients)
          .setReplyTo(new Sender('MS_CUXpzj@estate-admin.com', 'EstateAdmin Support'))
          .setSubject('Bienvenido a EstateAdmin')
          .setHtml(emailHtml);

        await mailerSend.email.send(emailParams);
        this.logger.log(`Correo enviado a ${userData.email}`);

      } catch (error) {
        console.log(error)
        this.logger.error(`Error al registrar el usuario ${userData.email}: ${error.message}`, error.stack);
      }
    }
  }
}
