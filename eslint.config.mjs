import globals from "globals";

export default [
    {
        languageOptions: {
            ecmaVersion: "latest",
            sourceType: "module",
            globals: {
                ...globals.node,
            },
        },
        rules: {
            indent: "warn",
        },
    },
];
