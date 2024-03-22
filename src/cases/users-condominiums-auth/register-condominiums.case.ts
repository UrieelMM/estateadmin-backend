import { Injectable, BadRequestException } from '@nestjs/common';
import * as admin from 'firebase-admin';
import { readExcel } from '../../utils/readExcel';
import { generatePassword } from 'src/utils/generatePassword';
import * as XLSX from 'xlsx';
import { UserCondominiumDto } from 'src/dtos/register-user-condominium.dto';
import { EmailParams, Sender, Recipient } from "mailersend";
import { mailerSend } from 'src/utils/mailerSend';


@Injectable()
export class RegisterCondominiumUsersCase {
  async execute(fileBuffer: Buffer,  clientId: string, condominiumId: string): Promise<Buffer> {
    const usersData: UserCondominiumDto[] = readExcel(fileBuffer) as UserCondominiumDto[];

    if (usersData.length === 0) {
      throw new BadRequestException('El archivo Excel está vacío o no tiene el formato correcto.');
    }

    const results = [];
    for (const userData of usersData) {
      try {
        const password = generatePassword();

        const userRecord = await admin.auth().createUser({
          email: userData.email,
          password,
        });

        console.log('Successfully created new user:', {email: userData.email, uid: userRecord.uid, password});

        await admin
        .auth()
        .setCustomUserClaims(userRecord.uid, { clientId: clientId, role: 'condominium', condominiumId});

        console.log('Successfully set custom claims:', {clientId, role: 'condominium', condominiumId});

        const profilePath = `clients/${clientId}/condominiums/${condominiumId}/users`;
        await admin.firestore().collection(profilePath).doc(userRecord.uid).set({
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
          number: userData.number || '',
          businessName: userData.businessName || '',
          taxResidence: userData.taxResidence || '',
          taxtRegime: userData.taxtRegime || '',
          photoURL: userData.photoURL || '',
          departament: userData.departament || '',
          uid: userRecord.uid,
          role: userData.role || 'condominium',
        });

        results.push({ Email: userData.email, Password: password });

        // Enviar un correo electrónico al usuario con su contraseña temporal
        const sentFrom = new Sender("estateadmin@urieel.dev", "EstateAdmin Support");
        const recipients = [
          new Recipient(`${userData.email}`, `${userData.name} ${userData.lastName}`)
        ];

        const htmlTemplate = (
          userData: any,
        ) => `
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
              color: #ffffff !important;
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
                <h1 style="color: white; margin: 0; font-size: 24px;">Tu cuenta está lista</h1>
              </td>
            </tr>
            <tr>
              <td style="padding: 20px 0; text-align: center;">
                <table style="width: 100%; margin: 20px auto 0 auto; background-color: #f6f6f6; padding: 20px 10px; border-radius: 10px;">
                  <tr>
                    <td style=" border-radius: 5px 5px 0 0; padding: 10px; text-align: center;">
                      <h2 style="color: #6366F1; font-size: 20px; margin-bottom: 0;">Hola, ${userData.name} Has sido registrado en EstateAdmin</h2>
                    </td>
                  </tr>
                  <tr>
                    <td style="padding: 10px 0; font-size: 22px; font-weight: normal; font-size: 14px;" width="200">Te compartimos tu contraseña temporal, te sugerimos cambiarla a la breveded posible.</td>
                  </tr>
                  <tr style="margin: 20px 0;">
                    <td style="padding: 10px 0; font-size: 22px; font-weight: bold; font-size: 44px; background-color: #FFF; padding: 20px; border-radius: 10px;" width="200">${password}</td>
                  </tr>
                  <tr>
                    <td style="text-align: center;">
                      <a href="https://www.urieel.dev" class="button">Ir a mi cuenta</a>
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
                <p>© Omnipixel</p>
              </td>
            </tr>
          </table>
        </body>
      </html>
    `;
        let emailHtml = htmlTemplate(
          userData,
        );

        const emailParams = new EmailParams()
          .setFrom(sentFrom)
          .setTo(recipients)
          .setReplyTo(sentFrom)
          .setSubject("Tu cuenta ha sido creada exitosamente")
          .setHtml(emailHtml);

        await mailerSend.email.send(emailParams);

      } catch (error) {
        console.error('Error al registrar el usuario:', error);
        // Agregar el error a los resultados sin detener todo el proceso
        results.push({ Email: userData.email, Error: `Error al registrar el usuario. ${error}` });
      }
    }

    // Generar y retornar el archivo Excel con las credenciales
    return this.generateCredentialsExcel(results);
  }

  private generateCredentialsExcel(data: any[]): Buffer {
    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Credentials');

    const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'buffer' });
    return buffer;
  }
}