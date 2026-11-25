import fs from 'node:fs';

const args = process.argv.slice(2);
const [source, destination] = args[0] === '--check'
    ? [args[1], null]
    : ['private-local/galetobot-workflow-real.json', 'docs/n8n/galetobot-publicado.sanitized.json'];
if (!source || (destination && args.length) || (!destination && args.length !== 2)) {
    throw new Error('Uso: node scripts/sanitize-workflow.mjs [--check <export.json>]');
}
const document = JSON.parse(fs.readFileSync(source, 'utf8').replace(/^\uFEFF/, ''));
const workflow = Array.isArray(document) && document.length === 1 ? document[0] : document;
const names = new Set(workflow.nodes.map(node => node.name));
if (workflow.nodes.length !== names.size) throw new Error('Há nomes de nós duplicados.');

function requireNode(name) {
    if (!names.has(name)) throw new Error(`Referência a nó ausente: ${name}`);
}

function checkReferences(value) {
    if (typeof value === 'string') {
        for (const match of value.matchAll(/(?:\$\(\s*|\$node\[\s*|\$items\(\s*)(['"])(.*?)\1/g)) requireNode(match[2]);
    } else if (value && typeof value === 'object') {
        Object.values(value).forEach(checkReferences);
    }
}

for (const [name, outputs] of Object.entries(workflow.connections)) {
    requireNode(name);
    for (const connection of Object.values(outputs).flat(2).filter(Boolean)) requireNode(connection.node);
}
workflow.nodes.forEach(node => checkReferences(node.parameters));
console.log(`Referências estáticas verificadas em ${names.size} nós.`);
if (destination) {
    const expected = ['Webhook1', 'HTTP Request1', 'Precisa do Gemini?1', 'Message a model1', 'Code in JavaScript1',
        'Executar conversa?', 'API de conversas1', 'Preparar resposta HTTP', 'Respond to Webhook1'];
    expected.forEach(requireNode);
    if (names.size !== expected.length) throw new Error('O export contém nós adicionais. Revise antes de publicar.');

    const endpoints = {
        'HTTP Request1': '/api/integrations/conversation/context',
        'API de conversas1': '/api/integrations/conversation'
    };
    const nodes = workflow.nodes.map(({ id, name, type, typeVersion, position, parameters, onError, continueOnFail, retryOnFail }) => ({
        id, name, type, typeVersion, position, parameters: Object.hasOwn(endpoints, name)
            ? { ...parameters, url: `http://api.example.invalid:3001${endpoints[name]}` }
            : parameters,
        onError, continueOnFail, retryOnFail
    }));
    for (const node of nodes) {
        const parameters = JSON.stringify(node.parameters);
        if (/(?:192\.168\.|10\.\d{1,3}\.\d{1,3}\.|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.)\d{1,3}|AIza[\w-]{35}|-----BEGIN .*PRIVATE KEY-----/i.test(parameters) ||
            /"name"\s*:\s*"(?:authorization|x-integration-token|x-galetobot-token|x-api-key)"\s*,\s*"value"/i.test(parameters)) {
            throw new Error(`Revise valores privados nos parâmetros de ${node.name} antes de publicar.`);
        }
    }
    const output = {
        name: 'GaletoBot - KODIE - Gemini IA',
        active: false,
        nodes,
        connections: workflow.connections,
        settings: { executionOrder: 'v1', saveDataErrorExecution: 'none', saveDataSuccessExecution: 'none', saveManualExecutions: false },
        pinData: {}
    };
    fs.writeFileSync(destination, JSON.stringify(output, null, 2) + '\n', { flag: 'wx' });
    console.log('Cópia gerada. Revise manualmente os parâmetros e o prompt antes de adicioná-la ao Git.');
}
