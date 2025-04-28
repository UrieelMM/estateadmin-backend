import { MailerSend, EmailParams, Recipient, Sender } from 'mailersend';
import * as admin from 'firebase-admin';

export class PublicationsService {
  private mailerSend: any;

  constructor() {
    this.mailerSend = new MailerSend({
      apiKey:
        process.env.MAILERSEND_API_KEY ||
        'mlsn.0cda1e684fe67e14b7b569d23fc3d66bcb1950417ef2eb9f18007246c6e5a57a',
    });
  }

  /**
   * Verifica si el usuario desea recibir notificaciones por correo electrónico
   * @param clientId ID del cliente
   * @param condominiumId ID del condominio
   * @param userId ID del usuario o null si se debe buscar por email
   * @param email Email del usuario para buscar si no se tiene userId
   * @returns Objeto con las preferencias de notificación y datos del usuario
   */
  async checkUserNotificationPreference(
    clientId: string,
    condominiumId: string,
    userId: string | null,
    email: string,
  ): Promise<{
    wantsEmailNotifications: boolean;
    userData: any | null;
  }> {
    try {
      let userDoc;

      if (userId) {
        // Si tenemos userId, buscamos directamente por ID
        const userRef = admin
          .firestore()
          .doc(
            `clients/${clientId}/condominiums/${condominiumId}/users/${userId}`,
          );
        userDoc = await userRef.get();
      } else {
        // Si no tenemos userId, buscamos por email
        const usersRef = admin
          .firestore()
          .collection(
            `clients/${clientId}/condominiums/${condominiumId}/users`,
          );
        const querySnapshot = await usersRef
          .where('email', '==', email)
          .limit(1)
          .get();

        if (!querySnapshot.empty) {
          userDoc = querySnapshot.docs[0];
        }
      }

      if (!userDoc || !userDoc.exists) {
        console.log(`No se encontró el usuario con email: ${email}`);
        return {
          wantsEmailNotifications: false,
          userData: null,
        };
      }

      const userData = userDoc.data();

      // Verificar si el usuario quiere recibir notificaciones por correo
      // Si el campo notifications no existe o si notifications.email es false, no se envía notificación
      // Solo se envía si existe notifications Y notifications.email es explícitamente true
      const wantsEmailNotifications = userData?.notifications?.email === true;

      return { wantsEmailNotifications, userData };
    } catch (error) {
      console.error('Error al verificar preferencias de notificación:', error);
      // Por defecto, asumimos que no quiere notificaciones en caso de error
      return {
        wantsEmailNotifications: false,
        userData: null,
      };
    }
  }

  /**
   * Genera la plantilla HTML del correo para publicaciones
   * @param userData Datos del usuario
   * @param publicationData Datos de la publicación
   * @param attachmentUrls URLs de los archivos adjuntos
   * @returns Plantilla HTML del correo
   */
  private generatePublicationEmailTemplate(
    userData: any,
    publicationData: any,
    attachmentUrls: any[] = [],
  ): string {
    return `
      <html>
        <head>
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;500;600;700&display=swap');
            
            body { 
              font-family: 'Poppins', sans-serif; 
              margin: 0; 
              padding: 0; 
              background-color: #f5f7fa;
              color: #333;
              line-height: 1.6;
            }
            
            .container { 
              max-width: 600px; 
              margin: 40px auto; 
              background-color: #ffffff; 
              border-radius: 16px; 
              overflow: hidden;
              box-shadow: 0 4px 24px rgba(0, 0, 0, 0.08);
            }
            
            .header { 
              background-color: #6366F1; 
              padding: 30px 20px; 
              text-align: center; 
            }
            
            .header img { 
              width: 120px; 
              height: auto; 
              margin-bottom: 15px;
            }
            
            .header h1 { 
              color: #ffffff; 
              margin: 0; 
              font-size: 24px; 
              font-weight: 600;
              letter-spacing: 0.5px;
            }
            
            .content { 
              padding: 40px 30px; 
              background-color: #ffffff;
            }
            
            .greeting {
              font-size: 22px;
              font-weight: 600;
              color: #2d3748;
              margin-bottom: 15px;
            }
            
            .message {
              font-size: 16px;
              color: #4a5568;
              margin-bottom: 30px;
            }
            
            .publication-card {
              background-color: #f8fafc;
              border-radius: 12px;
              padding: 25px;
              margin-bottom: 30px;
              border-left: 4px solid #6366F1;
            }
            
            .publication-title {
              font-size: 18px;
              font-weight: 600;
              color: #2d3748;
              margin-bottom: 20px;
            }
            
            .publication-content {
              font-size: 16px;
              color: #4a5568;
              margin-bottom: 20px;
              white-space: pre-line;
            }
            
            .attachments {
              margin-top: 25px;
              border-top: 1px solid #e2e8f0;
              padding-top: 20px;
            }
            
            .attachment-title {
              font-size: 16px;
              font-weight: 600;
              color: #2d3748;
              margin-bottom: 15px;
            }
            
            .attachment-link {
              display: block;
              color: #6366F1;
              font-weight: 500;
              text-decoration: none;
              margin-bottom: 10px;
              padding: 10px;
              background-color: #eef2ff;
              border-radius: 8px;
              transition: background-color 0.2s;
            }
            
            .attachment-link:hover {
              background-color: #dbeafe;
            }
            
            .action-button {
              display: inline-block;
              background-color: #6366F1;
              color: white !important;
              text-decoration: none;
              padding: 15px 25px;
              border-radius: 8px;
              font-weight: 600;
              margin-top: 20px;
              margin-bottom: 10px;
              text-align: center;
              transition: background-color 0.2s;
            }
            
            .action-button:hover {
              background-color: #4f46e5;
            }
            
            .footer {
              background-color: #f8fafc;
              padding: 25px 20px;
              text-align: center;
              font-size: 14px;
              color: #718096;
              border-top: 1px solid #e2e8f0;
            }
            
            .social-links {
              margin: 15px 0;
            }
            
            .social-links a {
              color: #6366F1;
              text-decoration: none;
              margin: 0 10px;
              font-weight: 500;
            }
            
            .company {
              font-weight: 600;
              margin-top: 10px;
            }
            
            @media (max-width: 600px) {
              .content {
                padding: 30px 20px;
              }
              
              .publication-card {
                padding: 20px 15px;
              }
            }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <img src="https://firebasestorage.googleapis.com/v0/b/iahub-24.appspot.com/o/app%2Fassets%2Flogo%2F2.png?alt=media&token=5fb84508-cad4-405c-af43-cd1a4f54f521" alt="EstateAdmin">
              <h1>Nueva publicación en tu comunidad</h1>
            </div>
            
            <div class="content">
              <div class="greeting">Hola, ${userData.name || 'Residente'}</div>
              <div class="message">Tu comunidad ${publicationData.condominiumName || 'ha emitido'} una nueva publicación.</div>
              
              <div class="publication-card">
                <div class="publication-title">${publicationData.title || 'Comunicado importante'}</div>
                <div class="publication-content">${publicationData.content || 'Sin contenido'}</div>
                
                ${
                  attachmentUrls && attachmentUrls.length > 0
                    ? `
                <div class="attachments">
                  <div class="attachment-title">Archivos adjuntos:</div>
                  ${attachmentUrls
                    .map(
                      (url, index) =>
                        `<a href="${url}" class="attachment-link">Archivo adjunto ${
                          index + 1
                        }</a>`,
                    )
                    .join('')}
                </div>
                `
                    : ''
                }
              </div>
            </div>
            
            <div class="footer">
              <div>Modernidad y Eficacia en la Administración</div>
              <div class="social-links">
                <a href="URL_FACEBOOK">Facebook</a> | 
                <a href="URL_TWITTER">Twitter</a> | 
                <a href="URL_INSTAGRAM">Instagram</a>
              </div>
              <div class="company">Omnipixel</div>
            </div>
          </div>
        </body>
      </html>
    `;
  }

  /**
   * Envía un correo electrónico de notificación de publicación
   * @param email Correo electrónico del destinatario
   * @param userData Datos del usuario
   * @param publicationData Datos de la publicación
   * @returns Resultado del envío
   */
  async sendEmailNotification(
    email: string,
    userData: any,
    publicationData: any,
  ): Promise<any> {
    try {
      // Generar la plantilla HTML del correo
      const emailHtml = this.generatePublicationEmailTemplate(
        userData,
        publicationData,
        publicationData.attachmentPublications || [],
      );

      // Configurar los parámetros del correo
      const emailParams = new EmailParams()
        .setFrom(
          new Sender('MS_CUXpzj@estate-admin.com', 'EstateAdmin Support'),
        )
        .setTo([new Recipient(email, userData.name || 'Residente')])
        .setReplyTo(
          new Sender('MS_CUXpzj@estate-admin.com', 'EstateAdmin Support'),
        )
        .setSubject(
          `Nueva publicación en ${publicationData.condominiumName || 'tu comunidad'}: ${publicationData.title || 'Comunicado importante'}`,
        )
        .setHtml(emailHtml);

      // Enviar el correo
      await this.mailerSend.email.send(emailParams);
      console.log(`Correo de publicación enviado exitosamente a ${email}`);
      return true;
    } catch (error) {
      console.error('Error al enviar el correo de publicación:', error);
      return false;
    }
  }
}
