import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { buildCategories } from '../../gluarcSchema';

suite('Gluarc Schema Categories', () => {
    test('moves gmod.plugins into its own category after Workspace', () => {
        const schemaPath = path.resolve(__dirname, '../../../syntaxes/schema.json');
        const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8')) as object;
        const categories = buildCategories(schema);

        const workspaceIndex = categories.findIndex((category) => category.key === 'workspace');
        assert.ok(workspaceIndex >= 0, 'Workspace category missing');

        const pluginCategoryIndex = categories.findIndex((category) => category.key === 'workspacePlugins');
        assert.ok(pluginCategoryIndex >= 0, 'Plugins category missing');
        assert.strictEqual(pluginCategoryIndex, workspaceIndex + 1, 'Plugins category should appear immediately after Workspace');

        const pluginCategory = categories[pluginCategoryIndex];
        assert.strictEqual(pluginCategory.label, 'Plugins');
        assert.deepStrictEqual(pluginCategory.fields.map((field) => field.path.join('.')), ['gmod.plugins']);

        const workspaceCategory = categories[workspaceIndex];
        assert.ok(!workspaceCategory.fields.some((field) => field.path.join('.') === 'gmod.plugins'));
    });
});