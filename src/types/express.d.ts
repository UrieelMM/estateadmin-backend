// Esto extiende el namespace global de Express
declare namespace Express {
  namespace Multer {
    interface File {
      /** Nombre del campo del formulario */
      fieldname: string;
      /** Nombre original del archivo en la máquina del cliente */
      originalname: string;
      /** Tipo MIME del archivo */
      mimetype: string;
      /** Tamaño del archivo en bytes */
      size: number;
      /** La dirección del archivo almacenado en el disco */
      destination: string;
      /** El nombre del archivo dentro de destination */
      filename: string;
      /** La ubicación del archivo almacenado */
      path: string;
      /** Un buffer del archivo completo (solo disponible si no se usa diskStorage) */
      buffer: Buffer;
    }
  }
}
