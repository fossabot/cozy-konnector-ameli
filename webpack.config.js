var path = require('path')
const CopyPlugin = require('copy-webpack-plugin')

module.exports = {
  entry: './src/index.js',
  target: 'node',
  output: {
    path: path.join(__dirname, 'build'),
    filename: 'index.js'
  },
  module: {
    rules: [
      {
        test: /\.js$/,
        include: [
          path.resolve(__dirname, 'src'),
          path.resolve('node_modules/cozy-konnector-libs')
        ],
        use: {
          loader: 'babel-loader',
          options: {
            presets: [
              ['env', {
                'targets': {
                  'node': '6.10'
                }
              }]
            ],
            plugins: [
              'transform-object-rest-spread'
            ]
          }
        }
      }
    ]
  },
  plugins: [
    new CopyPlugin([
      { from: 'manifest.konnector' },
      { from: 'package.json' },
      { from: 'README.md' },
      { from: 'LICENSE' }
    ])
  ]
}
