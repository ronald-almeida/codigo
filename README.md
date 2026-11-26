# Checkout Pix — Black Vitalícia | Combo de Oratória

Checkout responsivo inspirado na referência fornecida, com imagem original do produto, valor fixo de **R$ 247,00**, pagamento somente por Pix, sem CEP e sem cupom. Os botões de reembolso e WhatsApp e a informação sobre o prazo de acesso de **24 horas após a confirmação** ficam na página de obrigado. Conforme definido pelo responsável pelo produto, o prazo também será informado na copy enviada ao cliente antes da compra, sem repetir o aviso no checkout.

## Publicar na Vercel

1. Importe o repositório `ronald-almeida/codigo`.
2. Use a raiz do repositório, framework **Other**, Node.js **24.x**, build `node scripts/check.mjs` e diretório de saída `public`. A configuração já está em `vercel.json`.
3. Cadastre as variáveis abaixo no ambiente de produção. Nunca coloque credenciais na pasta `public` ou no Git.
4. Faça o deploy. Após alterar variáveis, faça um novo deploy.

| Variável | Valor |
| --- | --- |
| `NEXUM_CHAT_ID` | ID da conta/chat fornecido pela Nexum |
| `NEXUM_API_CREDENTIAL` | Credencial privada da Nexum |
| `CHECKOUT_SESSION_SECRET` | Segredo aleatório próprio deste projeto, com pelo menos 32 caracteres |
| `NEXUM_ORIGIN` | `https://nexumpaybot.com`, ou a origem autorizada pela Nexum para sua conta |
| `WHATSAPP_URL` | Opcional; padrão `https://wa.me/5575988393742` |

Gere o segredo da sessão em seu terminal com `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. Cadastre as três primeiras variáveis como segredos na hospedagem. Sem elas, os botões de pagamento ficam indisponíveis com uma mensagem clara.

O projeto precisa do backend Node.js. Não basta enviar apenas `public/` para uma hospedagem estática.

## Rodar localmente

Requer Node.js 24; não há dependências de produção para instalar.

```sh
node scripts/check.mjs
node --test --test-isolation=none test/checkout.test.mjs
node --env-file-if-exists=.env.local scripts/dev.mjs
```

Copie `.env.example` para `.env.local` e preencha as credenciais somente se for testar o provedor real. O servidor local usa `http://127.0.0.1:4173`.

Para a prévia simulada, sem cobrança e sem credenciais reais:

```sh
node test/browser-fixture.mjs
```

Acesse `http://127.0.0.1:4186`. Use apenas dados fictícios: nome `João Teste`, email `teste@example.com`, CPF de exemplo da documentação Nexum `09115751031` e telefone `(75) 99999-9999`. A prévia sinaliza que é um teste; seu QR não pode ser pago. A rota local `/fixture/paid` simula confirmação; `/fixture/reset` reinicia a prévia. Essas rotas não existem no backend publicado.

## Fluxo de pagamento

- O navegador envia os dados a `/api/order`, que valida nome, email, confirmação de email, CPF e telefone, fixa o preço no servidor e cria uma sessão criptografada HttpOnly.
- `/api/pix` chama `https://api.nexumpaybot.com/api/public/pix/create` com a mesma `Idempotency-Key`, corpo e referência em todas as tentativas do pedido. Recarregar a página recupera a cobrança existente.
- O QR e o código Copia e Cola vêm da Nexum; nenhum QR de pagamento da referência é reutilizado.
- `/api/status` consulta o provedor a cada 30 segundos e respeita `Retry-After`. Confere identificador e valor antes de aceitar o pagamento.
- Após confirmação, o navegador abre `/obrigado`. `/api/receipt` valida a sessão e o pagamento; parâmetros como `?paid=true` não liberam o recibo.
- A página de obrigado informa as 24 horas, abre o WhatsApp e direciona o pedido de reembolso para `https://reembolso-de-alunos.vercel.app/` sem anexar dados pessoais à URL.

Os dados pessoais ficam no cookie autenticado e criptografado durante a recuperação da cobrança e são removidos dele após confirmação. O telefone é validado, mas não é enviado à Nexum porque a documentação não define esse campo. A Nexum mantém o registro financeiro; não há banco de dados adicional neste projeto. A sessão dura sete dias. Ao limpar os cookies, use o suporte para recuperar uma compra anterior.

Este projeto confirma pagamentos e apresenta instruções; a entrega do curso após 24 horas e o atendimento de reembolsos são realizados pelo responsável pelo produto. Não há integração com a área de alunos nem envio automático de email. O link de reembolso abre a página indicada, sem executar automaticamente uma devolução.

## Verificação

Os testes cobrem validação, preço fixo, idempotência, recuperação de falha, estados pendentes, sessão adulterada, confirmação de valor, limite de consulta e acesso ao recibo. A prévia permite conferir checkout, QR, cópia e redirecionamento sem gerar cobranças reais. O pagamento real só pode ser validado após cadastrar as credenciais e realizar uma transação autorizada.

Referências: [checkout original](https://pay.hotmart.com/F108265667C), [API Nexum](https://app.nexumpaybot.com/api/index.html), [Node.js na Vercel](https://vercel.com/docs/functions/runtimes/node-js).
