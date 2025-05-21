import { Injectable, Logger } from '@nestjs/common';
import * as admin from 'firebase-admin';

@Injectable()
export class MpcService {
  private readonly logger = new Logger(MpcService.name);

  constructor() {
    // No necesitamos ninguna dependencia inyectada, usamos admin directamente
  }

  /**
   * Consulta una colección específica de Firebase basado en el prompt y metadatos
   */
  async queryCollectionByPrompt(params: {
    prompt: string;
    clientId: string;
    condominiumId: string;
    collection: string;
    limit?: number;
  }): Promise<any[]> {
    const { prompt, clientId, condominiumId, collection, limit = 100 } = params;
    
    // Identificar entidades relevantes (condóminos, fechas, etc.)
    const condominoMatch = prompt.match(/\b(?:cond[o\u00f3]mino|unidad)\s+(\d+)\b/i);
    let condominoNumber = condominoMatch ? condominoMatch[1] : null;
    
    // También intentar extraer un número aislado que podría ser un condómino
    if (!condominoNumber) {
      const simpleNumberMatch = prompt.match(/\b(\d{2,4})\b/); // Números de 2-4 dígitos como posibles unidades
      condominoNumber = simpleNumberMatch ? simpleNumberMatch[1] : null;
    }
    
    // Extraer fechas mencionadas
    const dateMatch = prompt.match(/\b(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\b/);
    const mentionedDate = dateMatch ? new Date(`${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`) : null;
    
    try {
      this.logger.log(`Querying collection ${collection} for client ${clientId}, condominium ${condominiumId}`);
      this.logger.log(`Looking for condomino: ${condominoNumber || 'none'}`);
      
      // Acceder a Firestore directamente a través de admin
      const db = admin.firestore();
      
      // Estructura correcta para condóminos: clients/clientId/condominiums/condominiumId/users/userId
      // Primero necesitamos encontrar el userId que corresponde al número de condómino
      if (condominoNumber) {
        // Ruta a la colección de usuarios
        const usersPath = `clients/${clientId}/condominiums/${condominiumId}/users`;
        this.logger.log(`Searching for condomino ${condominoNumber} in users collection: ${usersPath}`);
        
        try {
          // Obtener todos los usuarios y buscar los que tienen el número de condómino
          const usersRef = db.collection(usersPath);
          const usersSnapshot = await usersRef.get();
          
          if (!usersSnapshot.empty) {
            this.logger.log(`Found ${usersSnapshot.size} users total`);  
            
            // Lista para almacenar los IDs de usuario que corresponden al condómino buscado
            const matchingUserIds = [];
            
            // Revisar cada usuario para ver si es el condómino buscado
            for (const userDoc of usersSnapshot.docs) {
              const userData = userDoc.data();
              this.logger.log(`Checking user ${userDoc.id}: ${JSON.stringify(userData)}`);
              
              // Intentar encontrar coincidencias para el número de condómino
              const userDataStr = JSON.stringify(userData).toLowerCase();
              if (userDataStr.includes(condominoNumber) || 
                  (userData.numero && userData.numero == condominoNumber) || 
                  (userData.tower && userData.tower.toString() === condominoNumber) || 
                  (userData.unit && userData.unit.toString() === condominoNumber) || 
                  (userData.numeroCondominio && userData.numeroCondominio.toString() === condominoNumber) ||
                  (userData.unidad && userData.unidad.toString() === condominoNumber)) {
                
                this.logger.log(`===== FOUND MATCHING USER FOR CONDOMINO ${condominoNumber} =====`);
                this.logger.log(`User ID: ${userDoc.id}`);
                this.logger.log(`User Data: ${JSON.stringify(userData, null, 2)}`);
                
                matchingUserIds.push(userDoc.id);
              }
            }
            
            // Si encontramos usuarios que coinciden con el condómino
            if (matchingUserIds.length > 0) {
              const combinedResults = [];
              
              // Para cada usuario que coincide
              for (const userId of matchingUserIds) {
                this.logger.log(`Fetching data for user ${userId}`);
                
                // Consultar la colección específica solicitada (payments, expenses, etc.)
                if (collection !== 'users') { // Si no buscamos usuarios directamente
                  const userCollectionPath = `clients/${clientId}/condominiums/${condominiumId}/users/${userId}/${collection}`;
                  this.logger.log(`Checking collection: ${userCollectionPath}`);
                  
                  try {
                    const collectionRef = db.collection(userCollectionPath);
                    const collectionSnapshot = await collectionRef.limit(limit).get();
                    
                    if (!collectionSnapshot.empty) {
                      this.logger.log(`===== FOUND ${collectionSnapshot.size} ${collection.toUpperCase()} ITEMS FOR USER ${userId} =====`);
                      
                      collectionSnapshot.docs.forEach(doc => {
                        const data = doc.data();
                        this.logger.log(`ITEM ID: ${doc.id}`);
                        this.logger.log(`CONTENT: ${JSON.stringify(data, null, 2)}`);
                        
                        combinedResults.push({
                          id: doc.id,
                          ...data,
                          userId: userId,
                          condominoNumero: condominoNumber,
                          _path: userCollectionPath
                        });
                      });
                    } else {
                      this.logger.log(`No ${collection} items found for user ${userId}`);
                    }
                  } catch (e) {
                    this.logger.warn(`Error accessing collection ${collection} for user ${userId}: ${e.message}`);
                  }
                  
                  // Adicionalmente, buscar en colecciones comúnes que podrían contener datos para este usuario
                  const commonCollections = ['payments', 'expenses', 'records', 'maintenance', 'invoices', 'messages'];
                  if (commonCollections.includes(collection)) {
                    const commonPath = `clients/${clientId}/condominiums/${condominiumId}/${collection}`;
                    this.logger.log(`Checking common collection for user references: ${commonPath}`);
                    
                    try {
                      const commonRef = db.collection(commonPath);
                      const commonSnapshot = await commonRef.limit(100).get();
                      
                      if (!commonSnapshot.empty) {
                        this.logger.log(`Checking ${commonSnapshot.size} items in common collection for references to user ${userId}`);
                        
                        commonSnapshot.docs.forEach(doc => {
                          const data = doc.data();
                          const dataStr = JSON.stringify(data).toLowerCase();
                          
                          // Verificar si este documento hace referencia a nuestro usuario
                          if (dataStr.includes(userId) || 
                              dataStr.includes(condominoNumber) || 
                              (data.userId && data.userId === userId) || 
                              (data.usersId && Array.isArray(data.usersId) && data.usersId.includes(userId)) ||
                              (data.condominoNumero && data.condominoNumero.toString() === condominoNumber)) {
                            
                            this.logger.log(`FOUND RELATED ITEM IN COMMON COLLECTION:`);
                            this.logger.log(`ITEM ID: ${doc.id}`);
                            this.logger.log(`CONTENT: ${JSON.stringify(data, null, 2)}`);
                            
                            combinedResults.push({
                              id: doc.id,
                              ...data,
                              userId: userId,
                              condominoNumero: condominoNumber,
                              _foundIn: 'commonCollection',
                              _path: commonPath
                            });
                          }
                        });
                      }
                    } catch (e) {
                      this.logger.warn(`Error checking common collection ${collection}: ${e.message}`);
                    }
                  }
                } else {
                  // Si estamos buscando directamente información de usuarios, devolver el usuario encontrado
                  const userDoc = usersSnapshot.docs.find(doc => doc.id === userId);
                  if (userDoc) {
                    combinedResults.push({
                      id: userDoc.id,
                      ...userDoc.data(),
                      condominoNumero: condominoNumber,
                      _path: `${usersPath}/${userId}`
                    });
                  }
                }
              }
              
              // Si encontramos resultados relevantes, devolverlos
              if (combinedResults.length > 0) {
                this.logger.log(`Returning ${combinedResults.length} combined results for condomino ${condominoNumber}`);
                return combinedResults;
              }
            }
          }
        } catch (e) {
          this.logger.error(`Error searching for condomino ${condominoNumber} in users: ${e.message}`);
        }
      }
      
      // Si todavía estamos buscando un condómino específico y no lo encontramos en users, intentar en otras colecciones
      if (condominoNumber && ['payments', 'expenses', 'general', 'residents'].includes(collection)) {
        // Probar con otras estructuras como respaldo
        const condominoCollectionPaths = [
          `clients/${clientId}/condominiums/${condominiumId}/residents`,
          `clients/${clientId}/condominiums/${condominiumId}/condominios`,
          `clients/${clientId}/condominiums/${condominiumId}/condominios_units`,
          `clients/${clientId}/condominiums/${condominiumId}/units`
        ];
        
        for (const condominoPath of condominoCollectionPaths) {
          try {
            this.logger.log(`Intentando buscar condómino en: ${condominoPath}`);
            const condominosRef = db.collection(condominoPath);
            
            // Buscar por número de condómino tanto en string como en número
            const condominoQuery = condominosRef.where('numero', '==', condominoNumber);
            const numericQuery = condominosRef.where('numero', '==', parseInt(condominoNumber));
            
            const [condominoSnapshot, numericSnapshot] = await Promise.all([
              condominoQuery.get(),
              numericQuery.get()
            ]);
            
            // Si encontramos el condómino, intentar consultar sus datos específicos
            if (!condominoSnapshot.empty || !numericSnapshot.empty) {
              const condominoDoc = !condominoSnapshot.empty ? 
                condominoSnapshot.docs[0] : 
                numericSnapshot.docs[0];
              
              this.logger.log(`===== ENCONTRADO CONDÓMINO ${condominoNumber} =====`);
              this.logger.log(`ID: ${condominoDoc.id}`);
              this.logger.log(`DATA: ${JSON.stringify(condominoDoc.data(), null, 2)}`);
              
              // Intentar buscar subcolección específica para este condómino
              if (collection === 'payments') {
                const paymentsPaths = [
                  `${condominoPath}/${condominoDoc.id}/payments`,
                  `${condominoPath}/${condominoDoc.id}/pagos`,
                  `clients/${clientId}/condominiums/${condominiumId}/payments/by_condomino/${condominoNumber}`,
                  `clients/${clientId}/condominiums/${condominiumId}/pagos/by_condomino/${condominoNumber}`
                ];
                
                for (const paymentPath of paymentsPaths) {
                  try {
                    this.logger.log(`Intentando buscar pagos en: ${paymentPath}`);
                    const specificPaymentsRef = db.collection(paymentPath);
                    const paymentsSnapshot = await specificPaymentsRef.limit(limit).get();
                    
                    if (!paymentsSnapshot.empty) {
                      this.logger.log(`===== ENCONTRADOS ${paymentsSnapshot.size} PAGOS DEL CONDÓMINO ${condominoNumber} =====`);
                      
                      const results = [];
                      paymentsSnapshot.docs.forEach(doc => {
                        const data = doc.data();
                        this.logger.log(`PAGO ID: ${doc.id}`);
                        this.logger.log(`CONTENIDO: ${JSON.stringify(data, null, 2)}`);
                        
                        results.push({
                          id: doc.id,
                          ...data,
                          condominoNumero: condominoNumber,
                          _path: paymentPath
                        });
                      });
                      
                      return results;
                    }
                  } catch (e) {
                    this.logger.warn(`Error buscando pagos en ${paymentPath}: ${e.message}`);
                  }
                }
              }
            }
          } catch (e) {
            this.logger.warn(`Error buscando condómino en ${condominoPath}: ${e.message}`);
          }
        }
      }
      
      // Si llegamos aquí, seguimos con la búsqueda normal
      // Usar la estructura correcta de colecciones anidadas
      // clients/clientId/condominiums/condominiumId/[collection]
      const collectionPath = `clients/${clientId}/condominiums/${condominiumId}/${collection}`;
      let collectionRef = db.collection(collectionPath);
      
      // Crear la consulta base - ya no necesitamos filtrar por clientId/condominiumId
      // ya que están implícitos en la ruta
      let query: any = collectionRef;
      
      // Aplicar filtro por condómino si existe
      if (condominoNumber) {
        this.logger.log(`Applying condomino filter: ${condominoNumber}`);
        
        // Intentar diferentes campos donde podría estar el número de condómino
        // Nota: Firebase no permite OR en consultas, así que hacemos múltiples consultas
        const possibleFields = [
          'condominoNumero', 
          'numeroCondominio', 
          'condominoId', 
          'unidadId',
          'condomino',
          'unidad',
          'unitId',
          'unitNumber',
          'condominoId',
          'idCondomino'
        ];
        
        const results = [];
        
        // Intentar cada campo posible
        for (const field of possibleFields) {
          try {
            const fieldQuery = collectionRef
              .where(field, '==', condominoNumber)
              .limit(limit);
            
            const snapshot = await fieldQuery.get();
            
            if (!snapshot.empty) {
              this.logger.log(`===== ENCONTRADOS ${snapshot.size} DOCUMENTOS CON ${field}=${condominoNumber} =====`);
              
              snapshot.docs.forEach(doc => {
                const data = doc.data();
                this.logger.log(`DOCUMENTO ID: ${doc.id}`);
                this.logger.log(`CONTENIDO: ${JSON.stringify(data, null, 2)}`);
                
                results.push({
                  id: doc.id,
                  ...data
                });
              });
              
              this.logger.log(`Found ${snapshot.size} documents with ${field}=${condominoNumber}`);
            }
            
            // También intentar con el valor numérico
            const numericQuery = collectionRef
              .where(field, '==', parseInt(condominoNumber))
              .limit(limit);
            
            const numericSnapshot = await numericQuery.get();
            
            if (!numericSnapshot.empty) {
              this.logger.log(`===== ENCONTRADOS ${numericSnapshot.size} DOCUMENTOS NUMÉRICOS CON ${field}=${parseInt(condominoNumber)} =====`);
              
              numericSnapshot.docs.forEach(doc => {
                const data = doc.data();
                this.logger.log(`DOCUMENTO NUMÉRICO ID: ${doc.id}`);
                this.logger.log(`CONTENIDO NUMÉRICO: ${JSON.stringify(data, null, 2)}`);
                
                const docData = {
                  id: doc.id,
                  ...data
                };
                
                // Evitar duplicados
                if (!results.some(item => item.id === doc.id)) {
                  results.push(docData);
                }
              });
              
              this.logger.log(`Found ${numericSnapshot.size} documents with ${field}=${parseInt(condominoNumber)}`);
            }
          } catch (error) {
            // Ignorar errores de campos que no existen
            this.logger.warn(`Field ${field} query failed: ${error.message}`);
          }
        }
        
        // Si encontramos resultados, los devolvemos
        if (results.length > 0) {
          return results.slice(0, limit);
        }
      }
      
      // Si no hay filtro específico o no encontramos resultados, hacemos una consulta general
      query = query.limit(limit);
      
      const snapshot = await query.get();
      this.logger.log(`Found ${snapshot.size} documents in general query for collection ${collection}`);
      
      if (!snapshot.empty) {
        this.logger.log(`===== ENCONTRADOS ${snapshot.size} DOCUMENTOS EN CONSULTA GENERAL PARA ${collectionPath} =====`);
        snapshot.docs.forEach(doc => {
          const data = doc.data();
          this.logger.log(`DOCUMENTO GENERAL ID: ${doc.id}`);
          this.logger.log(`CONTENIDO GENERAL: ${JSON.stringify(data, null, 2)}`);
        });
      } else {
        this.logger.warn(`No documents found in ${collectionPath}`);
        // Intentar con rutas alternativas si la colección está anidada de otra manera
        const alternativePaths = [
          // Algunos casos pueden tener estructura diferente, verificamos opciones comunes:
          `clients/${clientId}/condominiums/${condominiumId}/records/${collection}`,
          `administration/${clientId}/condominiums/${condominiumId}/${collection}`,
          `clients/${clientId}/${collection}`,
        ];
        
        for (const altPath of alternativePaths) {
          try {
            this.logger.log(`Trying alternative path: ${altPath}`);
            const altCollectionRef = db.collection(altPath);
            const altSnapshot = await altCollectionRef.limit(limit).get();
            
            if (!altSnapshot.empty) {
              this.logger.log(`===== ENCONTRADOS ${altSnapshot.size} DOCUMENTOS EN RUTA ALTERNATIVA ${altPath} =====`);
              
              const resultados = [];
              altSnapshot.docs.forEach(doc => {
                const data = doc.data();
                this.logger.log(`DOCUMENTO RUTA ALTERNATIVA ID: ${doc.id}`);
                this.logger.log(`CONTENIDO RUTA ALTERNATIVA: ${JSON.stringify(data, null, 2)}`);
                
                resultados.push({
                  id: doc.id,
                  ...data,
                  _path: altPath // Añadir información de la ruta para debugging
                });
              });
              
              this.logger.log(`Found ${altSnapshot.size} documents in alternative path ${altPath}`);
              return resultados;
            }
          } catch (e) {
            this.logger.warn(`Error trying alternative path ${altPath}: ${e.message}`);
          }
        }
      }
      
      return snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));
      
    } catch (error) {
      this.logger.error(`Error querying collection ${collection}: ${error.message}`);
      return [];
    }
  }
  
  /**
   * Método para formatear los resultados de una consulta a una colección
   * @param results Resultados de la consulta
   * @param category Categoría o nombre de la colección
   * @returns Texto formateado con los resultados
   */
  formatCollectionResults(results: any[], category: string): string {
    if (!results || results.length === 0) {
      return '';
    }
    
    // Formatear los resultados dependiendo de la categoría
    let formattedText = `INFORMACIÓN DE ${category.toUpperCase()} (${results.length} registros):\n\n`;
    
    results.forEach((item, index) => {
      formattedText += `REGISTRO ${index + 1}:\n`;
      
      // Extraer campos principales primero
      const mainFields = ['id', 'fecha', 'monto', 'descripcion', 'condominoNumero', 'numeroCondominio', 'status'];
      mainFields.forEach(field => {
        if (item[field] !== undefined) {
          // Formatear fechas si es posible
          if (field === 'fecha' && item[field] && typeof item[field] === 'object') {
            try {
              const date = item[field].toDate ? item[field].toDate() : new Date(item[field]);
              formattedText += `${field}: ${date.toLocaleDateString()}\n`;
            } catch (e) {
              formattedText += `${field}: ${item[field]}\n`;
            }
          } else {
            formattedText += `${field}: ${item[field]}\n`;
          }
        }
      });
      
      // Agregar campos adicionales, excluyendo clientId y condominiumId que ya están implícitos
      Object.keys(item)
        .filter(key => !mainFields.includes(key) && key !== 'clientId' && key !== 'condominiumId' && key !== '_path')
        .forEach(key => {
          // No incluir objetos o arrays complejos
          if (item[key] !== null && typeof item[key] !== 'object') {
            formattedText += `${key}: ${item[key]}\n`;
          }
        });
      
      formattedText += '\n';
    });
    
    return formattedText;
  }
  

}
