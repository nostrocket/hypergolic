<script lang="ts">
    import { Card, Chart } from 'flowbite-svelte';
  
    const options = {
      series: [35.1, 23.5, 2.4, 5.4],
      colors: ['#9b1c1c', '#16BDCA', '#FDBA8C', '#E74694'],
      chart: {
        height: 320,
        width: '100%',
        type: 'donut'
      },
      stroke: {
        colors: ['transparent'],
        lineCap: ''
      },
      plotOptions: {
        pie: {
          donut: {
            labels: {
              show: true,
              name: {
                show: true,
                fontFamily: 'Inter, sans-serif',
                offsetY: 20
              },
              total: {
                showAlways: false,
                show: false,
                label: 'Merit Distribution',
                fontFamily: 'Inter, sans-serif',
                formatter: function (w) {
                  const sum = w.globals.seriesTotals.reduce((a, b) => {
                    return a + b;
                  }, 0);
                  return `${sum}k`;
                }
              },
              value: {
                show: true,
                fontFamily: 'Inter, sans-serif',
                offsetY: -20,
                formatter: function (value) {
                  return value + 'k';
                }
              }
            },
            size: '40%'
          }
        }
      },
      grid: {
        padding: {
          top: -2
        }
      },
      labels: ['Direct', 'Sponsor', 'Affiliate', 'Email marketing'],
      dataLabels: {
        enabled: false
      },
      legend: {
        show: false,
        position: 'bottom',
        fontFamily: 'Inter, sans-serif'
      },
      yaxis: {
        
        labels: {
          formatter: function (value) {
            return value + 'k';
          }
        }
      },
      xaxis: {
        labels: {
          formatter: function (value) {
            return value + 'k';
          }
        },
        axisTicks: {
          show: false
        },
        axisBorder: {
          show: false
        }
      }
    };

//     <Card>
//     <div class="flex justify-between items-start w-full">
//       <div class="flex-col items-center">
//         <div class="flex items-center mb-1">
//           <h5 class="text-xl font-bold leading-none text-gray-900 dark:text-white me-1">Merit Distribution</h5>
          
          
//         </div>
//       </div>

//     </div>
// </Card>
  </script>
  

    <Chart {options} class="py-6" />
  

  