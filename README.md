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
| `NEXUM_ORIGIN` | `https://botnexumpay.com`, origem aceita pela API atual da Nexum |
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

Para verificar falhas de geração, altere o simulador pela rota local `/fixture/mode?value=failure`, `processing` ou `missing-code` e clique em gerar: o formulário deve continuar aberto com erro vermelho. Volte para `value=success` e tente novamente: só então a tela do Pix deve aparecer. `/fixture/stats` informa se as tentativas mantiveram o mesmo pedido e corpo, sem exibir os dados do comprador. `/fixture/legacy` cria uma sessão antiga fictícia: o checkout deve abrir vazio e editável e remover os valores do cookie.

## Fluxo de pagamento

- O navegador envia os dados a `/api/order`, que valida nome, email, confirmação de email, CPF e telefone, fixa o preço no servidor e cria uma sessão criptografada HttpOnly contendo somente referências técnicas, sem os valores dos campos.
- `/api/pix` chama `https://api.botnexumpay.com/api/public/pix/create` com a mesma `Idempotency-Key`, corpo e referência em todas as tentativas do pedido. As tentativas na mesma página podem reutilizar a referência, sem guardar os dados do pagador no navegador.
- O QR e o código Copia e Cola vêm da Nexum; nenhum QR de pagamento da referência é reutilizado.
- A tela de pagamento só aparece quando a API devolve um código Pix disponível. Se a geração falhar ou ainda estiver em processamento, o formulário continua aberto e exibe um erro vermelho abaixo dos botões. Tentativas com os mesmos dados na mesma página podem reutilizar a referência técnica, sem botões separados de recuperação ou consulta manual.
- Quando a tentativa falha antes de chegar ao provedor (por exemplo, erro de DNS), ou é recusada sem criar transação, ela é descartada. O formulário permanece visível e editável e o botão permite gerar novamente, com a mensagem “Não foi possível gerar o Pix. Tente novamente.”. O próximo envio cria uma nova tentativa. Em respostas incertas de uma transação que pode ter sido criada, a referência técnica continua idempotente para evitar duplicidade.
- Abrir ou atualizar a página exibe o formulário vazio, com todos os campos editáveis e sem restaurar uma compra anterior. Os campos usam autocomplete="off" e não usam localStorage ou sessionStorage. Cookies antigos são regravados sem os dados pessoais. Editar os dados e gerar envia os novos valores, sem reutilizar silenciosamente os campos de outro pedido.
- `/api/status` consulta o provedor a cada 30 segundos e respeita `Retry-After`. Confere identificador e valor antes de aceitar o pagamento.
- Após confirmação, o navegador abre `/obrigado`. `/api/receipt` valida a sessão e o pagamento; parâmetros como `?paid=true` não liberam o recibo.
- A página de obrigado informa as 24 horas, abre o WhatsApp e direciona o pedido de reembolso para `https://reembolso-de-alunos.vercel.app/` sem anexar dados pessoais à URL.

Nome, email e CPF são enviados à Nexum durante a geração e não são gravados em cookies, localStorage ou sessionStorage. O cookie contém apenas referências técnicas e uma assinatura irreversível dos dados para validar tentativas do mesmo pedido. O telefone é validado, mas não é enviado à Nexum porque a documentação não define esse campo. A Nexum mantém o registro financeiro; não há banco de dados adicional neste projeto. A sessão dura sete dias. Ao limpar os cookies, use o suporte para recuperar uma compra anterior.

Este projeto confirma pagamentos e apresenta instruções; a entrega do curso após 24 horas e o atendimento de reembolsos são realizados pelo responsável pelo produto. Não há integração com a área de alunos nem envio automático de email. O link de reembolso abre a página indicada, sem executar automaticamente uma devolução.

## Verificação

Os testes cobrem validação, preço fixo, idempotência, recuperação de falha, estados pendentes, sessão adulterada, confirmação de valor, limite de consulta e acesso ao recibo. A prévia permite conferir checkout, QR, cópia e redirecionamento sem gerar cobranças reais. O pagamento real só pode ser validado após cadastrar as credenciais e realizar uma transação autorizada.

`GET /api/health` verifica a autenticação com a Nexum, a disponibilidade da conta e se o valor está nos limites permitidos, sem criar cobrança nem retornar saldo, identificadores da conta ou credenciais.

Referências: [checkout original](https://pay.hotmart.com/F108265667C), [API Nexum](https://app.nexumpaybot.com/api/index.html), [Node.js na Vercel](https://vercel.com/docs/functions/runtimes/node-js).
