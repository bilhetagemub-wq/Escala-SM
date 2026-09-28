# Escala São Miguel: atualização

## Arquivos

Substitua ou adicione no projeto (mesma estrutura de pastas):

| Arquivo | Situação |
|---|---|
| `dashboard.html`, `js/dashboard.js`, `css/dashboard.css` | substituir |
| `pages/funcionarios.html`, `js/funcionarios.js`, `css/funcionarios.css` | substituir |
| `pages/escalas.html`, `js/escalas.js`, `css/escalas.css` | substituir |
| `js/escala-engine.js` | novo (motor de rodízio) |
| `js/dados.js` | novo (acesso ao Firestore) |
| `js/layout.js`, `css/layout.css` | novo (menu lateral e avisos) |
| `img/logo-sao-miguel.jpg` | novo |

Sem mudança: `login.html`, `index.html`, `js/auth.js`, `js/firebase.js`, `css/style.css`, `css/login.css`.

## Coleções no Firestore

- `equipes`: nome, cor, ordem
- `funcionarios`: os campos antigos + `equipeId` e `ordem`
- `feriados`: data (AAAA-MM-DD), descricao, equipeFixaId
- `config/escala`: regras do rodízio
- `escalas/AAAA-MM`: trocas, ausências e um retrato do mês salvo

Funcionários já cadastrados aparecem na coluna "Sem equipe". Basta arrastá-los.

## Regras de segurança sugeridas

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{colecao}/{id} {
      allow read, write: if request.auth != null
        && colecao in ['funcionarios', 'equipes', 'feriados', 'config', 'escalas'];
    }
  }
}
```
