import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import * as admin from 'firebase-admin';
import { readExcel } from '../../utils/readExcel';
import * as XLSX from 'xlsx';
import { UserCondominiumDto } from 'src/dtos/register-user-condominium.dto';
import { EmailParams, Sender, Recipient } from 'mailersend';
import { mailerSend } from 'src/utils/mailerSend';

interface RegistrationResult {
  name: string;
  email: string;
  status: 'success' | 'error';
  message: string;
}

@Injectable()
export class RegisterCondominiumUsersCase {
  private readonly logger = new Logger(RegisterCondominiumUsersCase.name);

  async execute(
    fileBuffer: Buffer,
    clientId: string,
    condominiumId: string,
  ): Promise<Buffer> {
    try {
      if (!clientId) {
        throw new BadRequestException('ClientId es requerido.');
      }
      if (!condominiumId) {
        throw new BadRequestException('CondominiumId es requerido.');
      }

      // Obtener los datos del archivo Excel (omitiendo la primera fila de encabezados)
      const rawUsersData: UserCondominiumDto[] = readExcel(
        fileBuffer,
      ) as UserCondominiumDto[];

      if (rawUsersData.length === 0) {
        throw new BadRequestException(
          'El archivo Excel está vacío o no tiene el formato correcto.',
        );
      }

      // Obtener el límite de condominios para este cliente
      const condominiumRef = await admin
        .firestore()
        .collection(`clients/${clientId}/condominiums`)
        .doc(condominiumId)
        .get();

      if (!condominiumRef.exists) {
        throw new BadRequestException('Condominio no encontrado.');
      }

      const condominiumData = condominiumRef.data();
      const condominiumLimit = condominiumData?.condominiumLimit || 50; // Valor por defecto si no se encuentra

      this.logger.log(
        `Límite de condominios para el cliente: ${condominiumLimit}`,
      );

      // Preparar un array para registrar los resultados de cada registro
      const registrationResults = [];

      // Limitar la cantidad de usuarios a procesar según el límite del plan
      const usersData = rawUsersData.slice(0, condominiumLimit);

      // Registramos cuántos usuarios fueron omitidos debido al límite
      const omittedUsers = Math.max(0, rawUsersData.length - condominiumLimit);
      if (omittedUsers > 0) {
        this.logger.warn(
          `Se omitieron ${omittedUsers} usuarios debido al límite del plan (${condominiumLimit}).`,
        );
      }

      // Procesar cada usuario del archivo Excel
      for (const userData of usersData) {
        const normalizedName = (userData.name || '').trim();
        const normalizedEmail = (userData.email || '').trim().toLowerCase();

        const result: RegistrationResult = {
          name: normalizedName,
          email: normalizedEmail,
          status: 'error',
          message: '',
        };

        try {
          // Validar datos mínimos requeridos
          if (!normalizedName) {
            result.message = 'El nombre es obligatorio.';
            registrationResults.push(result);
            continue;
          }
          // Verificar si el rol es administrativo (no permitido)
          const forbiddenRoles = [
            'admin',
            'admin-assistant',
            'super-admin',
            'superAdmin',
            'superadmin',
            'superAdmin',
            'super-admin',
            'superAdmin',
            'super-admin',
            'superAdmin',
            'super-admin',
            'editor',
            'editor-assistant',
            'editorAssistant',
            'editor-assistant',
            'editorAssistant',
            'editor-assistant',
            'editorAssistant',
            'viewer',
            'viewer-assistant',
            'viewerAssistant',
            'viewer-assistant',
            'viewerAssistant',
            'viewer-assistant',
            'viewerAssistant',
          ];
          if (
            userData.role &&
            forbiddenRoles.some((role) =>
              userData.role.toLowerCase().includes(role.toLowerCase()),
            )
          ) {
            this.logger.warn(
              `Intento de registro con rol administrativo no permitido: email=${userData.email}, role=${userData.role}`,
            );
            result.message = 'Rol administrativo no permitido.';
            registrationResults.push(result);
            continue;
          }

          // Verificar si el usuario ya existe
          const profilePath = `clients/${clientId}/condominiums/${condominiumId}/users`;
          if (normalizedEmail) {
            const existingUsers = await admin
              .firestore()
              .collection(profilePath)
              .where('email', '==', normalizedEmail)
              .get();

            if (!existingUsers.empty) {
              result.message =
                'El usuario con este correo electrónico ya existe.';
              registrationResults.push(result);
              continue;
            }
          }

          // Crear solo perfil en Firestore (sin crear cuenta en Firebase Auth)
          const uid = admin.firestore().collection(profilePath).doc().id;
          const docRef = admin.firestore().collection(profilePath).doc(uid);

          await docRef.set({
            name: normalizedName,
            email: normalizedEmail,
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
            tower: userData.tower || '',
            uid: uid,
            role: 'condominium',
            condominiumId: condominiumId || '',
            clientId: clientId || '',
            notifications: {
              email: true,
              whatsapp: true,
            },
          });

          this.logger.log(`Documento creado para usuario: email=${normalizedEmail || 'N/A'}, uid=${uid}`);

          // Preparar y enviar el correo electrónico
          const sentFrom = new Sender(
            'MS_Fpa0aS@notifications.estate-admin.com',
            'EstateAdmin Notifications',
          );
          const recipients = normalizedEmail
            ? [new Recipient(normalizedEmail, normalizedName || 'Sin nombre')]
            : [];

          // Función para generar la plantilla HTML del correo
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
              <table width="90%" style="background-color: #ffffff; border-radius: 10px; padding: 50px 40px; margin: 40px auto 0 auto; box-shadow: 5px 5px 10px rgba(0, 0, 0, .1);" cellspacing="0" cellpadding="0">
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
                          <p style="margin-top: 14px; margin-bottom: 0;">
                            En caso de que no desees recibir notificaciones por correo o WhatsApp, ponte en contacto con tu administración.
                          </p>
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

          if (normalizedEmail) {
            const emailHtml = htmlTemplate(userData);

            const emailParams = new EmailParams()
              .setFrom(sentFrom)
              .setTo(recipients)
              .setReplyTo(
                new Sender(
                  'MS_Fpa0aS@notifications.estate-admin.com',
                  'EstateAdmin Notifications',
                ),
              )
              .setSubject('Bienvenido a EstateAdmin')
              .setHtml(emailHtml);

            await mailerSend.email.send(emailParams);
            this.logger.log(`Correo enviado a ${normalizedEmail}`);
          } else {
            this.logger.log(
              `Usuario registrado sin correo electrónico, no se envía email: uid=${uid}`,
            );
          }

          // Actualizar resultado como exitoso
          result.status = 'success';
          result.message = normalizedEmail
            ? 'Usuario registrado correctamente.'
            : 'Usuario registrado correctamente (sin correo electrónico).';
          registrationResults.push(result);
        } catch (error) {
          console.log(error);
          this.logger.error(
            `Error al registrar el usuario ${normalizedEmail || normalizedName}: ${error.message}`,
            error.stack,
          );
          result.message = `Error: ${error.message || 'Error desconocido al procesar el usuario.'}`;
          registrationResults.push(result);
        }
      }

      // Si hay usuarios omitidos por el límite, añadirlos al resultado
      if (omittedUsers > 0) {
        for (let i = condominiumLimit; i < rawUsersData.length; i++) {
          const omittedUser = rawUsersData[i];
          registrationResults.push({
            name: omittedUser.name || '',
            email: omittedUser.email || '',
            status: 'error',
            message: `Usuario omitido debido al límite del plan (${condominiumLimit}).`,
          });
        }
      }

      // Crear un archivo Excel con los resultados
      const worksheet = XLSX.utils.json_to_sheet(registrationResults);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Resultados');

      // Convertir el libro de Excel a un buffer
      const excelBuffer = XLSX.write(workbook, {
        bookType: 'xlsx',
        type: 'buffer',
      });

      return excelBuffer;
    } catch (error) {
      this.logger.error(
        `Error durante el proceso de registro de condominios: ${error.message}`,
        error.stack,
      );
      throw new BadRequestException(
        `Error durante el registro de condominios: ${error.message}`,
      );
    }
  }
}
