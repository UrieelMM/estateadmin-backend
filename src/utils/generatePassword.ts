export function generatePassword() {
  let password = '';
  let characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let charactersLength = characters.length;
  for (let i = 0; i < 10; i++) {
    password += characters.charAt(Math.floor(Math.random() * charactersLength));
  }
  return password;
}