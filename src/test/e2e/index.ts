import * as path from 'path';
import Mocha = require('mocha');

export function run(): Promise<void> {
    const mocha = new Mocha({ ui: 'tdd', color: true, timeout: 90_000 });
    if (process.env.GLUALS_TEST_GREP) {
        mocha.grep(process.env.GLUALS_TEST_GREP);
    }
    mocha.addFile(path.resolve(__dirname, 'editor.test.js'));
    return new Promise((resolve, reject) => {
        mocha.run(failures => failures ? reject(new Error(`${failures} editor tests failed.`)) : resolve());
    });
}
